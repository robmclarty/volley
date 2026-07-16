/**
 * Docker sandbox orchestration (s2 Phase 2b; D5, D9, D11): isolate the local
 * builder's *blast radius*. Shape B keeps volley (Node, model client, tools) on
 * the host — only the `bash` tool's commands run inside a container, against the
 * bind-mounted worktree (`build_root`). volley's `write_file`/`edit_file` still
 * write host-side through `contain()`, so the container and the host see one
 * identical file tree across the bind mount.
 *
 * Lifecycle (D9): one long-lived, hardened container per run
 * (`docker run -d … sleep infinity`), then many `docker exec`s against it — the
 * universal agent-sandbox pattern. On Docker ≥ 19.03 each `exec`'d command
 * inherits the container's cap-drop / no-new-privileges / seccomp hardening
 * (moby #38871), so the `run` flag set below is the whole containment surface.
 * The lifecycle wraps the fascicle loop — it is not itself a loop — so these are
 * straight-line docker subprocess calls and the no-loops rule is unaffected.
 *
 * Network policy (default-deny egress, D6/D12): the container's legitimate egress
 * is the package registry for an in-container `pnpm install` and — under
 * whole-process containment (B′/D5, completing in step 13) — the host LLM endpoint
 * the in-container model client reaches via host-gateway. The default
 * posture is `--network none` — no interface, a complete L3 egress deny; the
 * opt-in `'allowlist'` posture attaches a dedicated user-defined bridge and
 * collapses the allowlist targets onto the host gateway (see `SandboxNetwork`).
 * This module owns container start / `exec` / reap / teardown, the D11 hardening
 * flags the `bash` swap rides on, and the network posture above.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { BashExecutor, BashOutcome } from './builder/tools.js';
import { config_error } from './types.js';

/** The in-container mount point for the bind-mounted worktree; matches the
 * `Dockerfile`'s `WORKDIR`. Every `docker exec` sets its cwd here, so a command
 * that uses a workspace-relative path resolves against the same tree volley's
 * file tools write host-side. */
const SANDBOX_WORKDIR = '/workspace';

/** The container user's home; matches the `Dockerfile`'s `node` user. `HOME` is
 * pinned here (a numeric `--user` has no `/etc/passwd` entry, so `~` is
 * otherwise unset) and its `.cache` is a tmpfs so the read-only rootfs does not
 * brick tools that scribble there. */
const SANDBOX_HOME = '/home/node';

/** Named volume for the pnpm store (D11): survives the read-only rootfs and
 * persists the content-addressed store across runs. (Making a `--user`-mapped,
 * non-1000 uid writable to a fresh volume is a footgun handled where pnpm
 * actually runs — the blessed examples — not here.) */
const SANDBOX_STORE_VOLUME = 'volley-pnpm-store';

/** The dedicated user-defined bridge for the `'allowlist'` network posture (D12).
 * A user-defined bridge (not the default `bridge`) isolates volley's sandbox from
 * other containers and is the attach point for the host-collapsed allowlist.
 * Created idempotently and left in place — shared across runs and cheap, like the
 * pnpm store volume; teardown never removes it. */
const SANDBOX_NETWORK_NAME = 'volley-sandbox-net';

/** Pinned subnet for that bridge, so the host-applied `DOCKER-USER` default-DROP
 * (below) can scope to volley's containers alone and never disturb other
 * containers on the host. An obscure /24 to keep collisions rare; a clash fails
 * `network create` loudly (exit 5) rather than silently sharing a subnet. */
const SANDBOX_NETWORK_SUBNET = '172.31.99.0/24';

/** How long a management docker call may run (start allows for an image pull;
 * exec-based readiness/reap are quick). Command execution has its own per-call
 * budget from the `bash` tool. */
const DOCKER_START_TIMEOUT_MS = 300_000;
const DOCKER_ADMIN_TIMEOUT_MS = 30_000;

/** A live sandbox: the container it runs against, the in-container cwd every
 * `exec` uses, and the PID set to preserve when reaping (PID 1 / the keep-alive
 * `sleep`, captured at start). */
export type SandboxHandle = {
  container: string;
  workdir: string;
  /** Space-padded (`" 1 7 "`) list of protected PIDs for the reaper's `case`
   * match — the processes present right after start, never reaped. */
  baseline: string;
};

type DockerResult = { status: number; stdout: string; stderr: string };

/** Run a docker management subcommand. A missing docker binary is a hard
 * precondition failure (exit 5, like the missing-repo guard); a non-zero exit
 * is returned for the caller to interpret. */
function docker(args: string[], timeout_ms: number): DockerResult {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: timeout_ms });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    throw config_error('docker is required for the builder sandbox but was not found on PATH');
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** The host uid/gid, present only on POSIX. When available it is exactly the
 * owner the container's `--user` must match (D11): volley created the worktree,
 * so the volley process owns the bind-mounted tree. When absent (non-POSIX) the
 * image's own non-root `node` user is the floor. */
function host_ids(): { uid: number; gid: number } | null {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) return null;
  return { uid, gid };
}

/** Run-unique container name. Docker names must start alphanumeric and use
 * `[A-Za-z0-9_.-]`; the run id is a UUID (hyphens only), so a `volley-sandbox-`
 * prefix is always valid. */
export function sandbox_container_name(run_id: string): string {
  return `volley-sandbox-${run_id}`;
}

/**
 * The container's egress posture (s2 D6/D12). Under whole-process containment
 * (B′/D5, completing in step 13) the model client and the `fetch` tool run inside
 * the container, so its legitimate egress is the package registry for `pnpm
 * install` plus the host LLM endpoint the model client reaches via host-gateway.
 *
 * - `'none'` — `--network none`: no interface at all, a complete L3 egress deny.
 *   The default-deny default and the fully-offline all-local posture (deps served
 *   from the pre-warmed pnpm store volume). With the whole process in-container,
 *   `fetch` has no route either, so it degrades cleanly to a returned error and the
 *   run continues.
 * - `'allowlist'` — the container sits on volley's dedicated user-defined bridge
 *   with `host.docker.internal:host-gateway`, collapsing the allowlist targets
 *   (the package registry, and the host LLM endpoint the in-container model client
 *   reaches — B′/D5) onto the host gateway. The L3/L4 default-DROP that
 *   makes the bridge a true allowlist is the host-applied, subnet-scoped
 *   `DOCKER-USER` rule volley documents but never installs itself — that chain is
 *   root and host-global (and, on Docker Desktop, inside a VM unreachable from an
 *   unprivileged per-run host process). The always-on tool-level SSRF deny-list is
 *   the second, in-process defense-in-depth layer. Host hardening, run once as root
 *   on a Linux host, scoped to volley's subnet so it never touches other
 *   containers (insert ahead of the chain's terminating RETURN, in order):
 *     iptables -I DOCKER-USER -s 172.31.99.0/24 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
 *     iptables -I DOCKER-USER -s 172.31.99.0/24 -d <host-gateway-ip> -j ACCEPT   # collapsed allowlist
 *     iptables -I DOCKER-USER -s 172.31.99.0/24 -p udp --dport 53 -j ACCEPT      # DNS
 *     iptables -I DOCKER-USER -s 172.31.99.0/24 -j DROP                          # default-deny the rest
 */
export type SandboxNetwork = 'none' | 'allowlist';

/**
 * The network-related `docker run` args for a posture (D6/D12), pure and exported
 * so the policy is unit-testable without a daemon. `'none'` denies all egress
 * (`--network none`); `'allowlist'` attaches the dedicated user-defined bridge and
 * collapses the allowlist targets onto the host gateway (`host.docker.internal`,
 * the Linux-portable spelling — harmless where Docker Desktop already provides it).
 */
export function network_run_args(network: SandboxNetwork, network_name: string): string[] {
  if (network === 'none') return ['--network', 'none'];
  return ['--network', network_name, '--add-host', 'host.docker.internal:host-gateway'];
}

/**
 * The `docker run` argv for the hardened, long-lived sandbox (D9/D11). Pure and
 * exported so the flag set is unit-testable without a daemon.
 *
 * Never emits `--privileged` and refuses `--user 0` (D9): volley must not hand
 * the sandbox root or full capabilities. Everything writable under the
 * `--read-only` rootfs is an explicit tmpfs or volume; the bind-mounted worktree
 * is the one host-visible write path.
 */
export function sandbox_run_args(options: {
  image: string;
  build_root: string;
  name: string;
  uid: number | null;
  gid: number | null;
  store_volume: string;
  network: SandboxNetwork;
  network_name: string;
}): string[] {
  if (options.uid === 0) {
    throw config_error('refusing to start the builder sandbox as root (uid 0)');
  }
  const user =
    options.uid !== null && options.gid !== null
      ? ['--user', `${String(options.uid)}:${String(options.gid)}`]
      : [];
  return [
    'run',
    '-d',
    '--name',
    options.name,
    ...user,
    // Network policy (D6/D12): default-deny egress. `'none'` gives the container
    // no interface; `'allowlist'` puts it on the user-defined bridge and collapses
    // the allowlist targets onto the host gateway.
    ...network_run_args(options.network, options.network_name),
    // Resource caps (D11): contain a runaway / fork-bomb / OOM without starving
    // pnpm/tsc (pids 1024, not 100; nofile high enough for esbuild/watchers).
    '--memory=4g',
    '--memory-swap=4g',
    '--memory-swappiness=0',
    '--cpus=2',
    '--pids-limit=1024',
    '--ulimit',
    'nofile=8192:16384',
    '--ulimit',
    'core=0',
    // Privilege caps (D9/D11): drop every capability, forbid privilege
    // escalation, keep the default seccomp profile, and run tini (PID 1) to reap
    // zombies. Never `--privileged`.
    '--cap-drop=ALL',
    '--security-opt',
    'no-new-privileges',
    '--init',
    // Read-only rootfs with tmpfs for the few writable paths the toolchain
    // needs; the pnpm store persists on a named volume.
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    '/run',
    '--tmpfs',
    `${SANDBOX_HOME}/.cache`,
    '-e',
    `HOME=${SANDBOX_HOME}`,
    // The bind-mounted worktree (writable — a bind mount is exempt from
    // `--read-only`) and the persistent pnpm store.
    '-v',
    `${options.build_root}:${SANDBOX_WORKDIR}`,
    '-v',
    `${options.store_volume}:${SANDBOX_HOME}/.local/share/pnpm/store`,
    '-w',
    SANDBOX_WORKDIR,
    options.image,
    'sleep',
    'infinity',
  ];
}

/** Snapshot the container's live PIDs right after start — PID 1 (tini) and the
 * keep-alive `sleep` — as the reaper's protected set. Excludes the snapshotting
 * shell itself (`$$`) so no soon-dead PID is protected; PID 1 is always added
 * back in case the snapshot raced. Doubles as a readiness probe: a non-zero exit
 * means the container never came up. */
function capture_baseline_pids(container: string): string {
  const snapshot =
    'me=$$; for d in /proc/[0-9]*; do p=${d#/proc/}; [ "$p" = "$me" ] && continue; printf "%s " "$p"; done';
  const res = docker(['exec', container, 'sh', '-c', snapshot], DOCKER_ADMIN_TIMEOUT_MS);
  if (res.status !== 0) {
    throw config_error(
      `builder sandbox container ${container} did not become ready: ${res.stderr.trim() || 'docker exec failed'}`,
    );
  }
  const pids = res.stdout.split(/\s+/).filter((p) => /^\d+$/.test(p));
  return ` ${['1', ...pids].join(' ')} `;
}

/**
 * Ensure the dedicated, subnet-pinned user-defined bridge exists for the
 * `'allowlist'` posture (D12), idempotently: create it, and treat an
 * already-exists failure (a racing or prior run) as success by re-inspecting.
 * Left in place across runs — shared and cheap, like the pnpm store volume — so
 * teardown never removes it. The `'none'` posture uses `--network none` and never
 * calls this. Throws `config_error` (exit 5) if the network can't be made ready.
 */
export function ensure_sandbox_network(name: string, log?: (message: string) => void): void {
  const created = docker(
    ['network', 'create', '--subnet', SANDBOX_NETWORK_SUBNET, name],
    DOCKER_ADMIN_TIMEOUT_MS,
  );
  if (created.status === 0) {
    log?.(`sandbox: created network ${name} (${SANDBOX_NETWORK_SUBNET}, default-deny egress + host-gateway allowlist)`);
    return;
  }
  // `create` fails when the name already exists (a concurrent or prior run) — a
  // shared bridge is the intent, so a present network is success, not an error.
  if (docker(['network', 'inspect', name], DOCKER_ADMIN_TIMEOUT_MS).status === 0) return;
  throw config_error(
    `failed to create the builder sandbox network (${name}): ${created.stderr.trim() || 'docker network create failed'}`,
  );
}

/**
 * Start one long-lived, hardened container for the run and bind-mount
 * `build_root` at `/workspace` (D5/D9/D11), on the chosen network posture
 * (D6/D12; defaults to the default-deny `'none'`). Throws `config_error` (exit 5)
 * when docker is missing, the `'allowlist'` network can't be readied, `run` fails,
 * or the container never becomes ready.
 */
export function start_sandbox(options: {
  image: string;
  build_root: string;
  run_id: string;
  network?: SandboxNetwork;
  log?: (message: string) => void;
}): SandboxHandle {
  const network = options.network ?? 'none';
  const name = sandbox_container_name(options.run_id);
  const ids = host_ids();
  if (network === 'allowlist') {
    ensure_sandbox_network(SANDBOX_NETWORK_NAME, options.log);
  }
  const args = sandbox_run_args({
    image: options.image,
    build_root: resolve(options.build_root),
    name,
    uid: ids?.uid ?? null,
    gid: ids?.gid ?? null,
    store_volume: SANDBOX_STORE_VOLUME,
    network,
    network_name: SANDBOX_NETWORK_NAME,
  });
  const run = docker(args, DOCKER_START_TIMEOUT_MS);
  if (run.status !== 0) {
    throw config_error(
      `failed to start the builder sandbox (${name}): ${run.stderr.trim() || run.stdout.trim() || 'docker run failed'}`,
    );
  }
  const handle: SandboxHandle = {
    container: name,
    workdir: SANDBOX_WORKDIR,
    baseline: capture_baseline_pids(name),
  };
  options.log?.(`sandbox: started container ${name} from ${options.image} (network: ${network})`);
  return handle;
}

/**
 * Reap every process the last command left running in the long-lived container
 * — a backgrounded job, or the command itself when a timeout SIGKILL'd only the
 * host `docker exec` client and left its in-container process orphaned onto PID 1
 * (D9). Preserves the baseline set (PID 1 + the keep-alive `sleep`) and the
 * reaper shell itself. Best-effort: reaping is hygiene and never fails a command.
 */
function reap_sandbox(handle: SandboxHandle): void {
  const script =
    'me=$$; for d in /proc/[0-9]*; do p=${d#/proc/}; ' +
    '[ "$p" = "$me" ] && continue; ' +
    'case "' +
    handle.baseline +
    '" in *" $p "*) continue ;; esac; ' +
    'kill -9 "$p" 2>/dev/null; done; exit 0';
  try {
    docker(['exec', handle.container, 'sh', '-c', script], DOCKER_ADMIN_TIMEOUT_MS);
  } catch {
    // Reaping is cleanup; never surface a reap failure as the command's result.
  }
}

/**
 * The `bash` executor that runs a command via `docker exec` against the run's
 * container (D1/D9). Each call is a fresh `sh -c` with cwd reset to `/workspace`
 * — the same stateless-per-command contract as the host `spawnSync` path (no
 * cwd/env drift). The command's exit status passes through; a timeout SIGKILLs
 * the host client and `timed_out` is set, then the reaper cleans up any process
 * left behind in the container.
 */
export function docker_exec_bash(handle: SandboxHandle): BashExecutor {
  return (command, opts) => {
    const result = spawnSync(
      'docker',
      ['exec', '-w', handle.workdir, handle.container, 'sh', '-c', command],
      {
        encoding: 'utf8',
        timeout: opts.timeout_ms,
        killSignal: 'SIGKILL',
        maxBuffer: opts.max_capture_bytes,
      },
    );
    const err = result.error as NodeJS.ErrnoException | undefined;
    const timed_out = err?.code === 'ETIMEDOUT';
    let stderr = result.stderr ?? '';
    // A docker-side failure (daemon gone mid-run, container removed) is opaque
    // otherwise — surface it so the model/operator sees more than a bare null.
    if (err !== undefined && !timed_out) {
      const detail = `[docker exec failed: ${err.message}]`;
      stderr = stderr.length > 0 ? `${stderr}\n${detail}` : detail;
    }
    const outcome: BashOutcome = {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr,
      timed_out,
    };
    reap_sandbox(handle);
    return outcome;
  };
}

/** Tear the container down (`docker rm -f`), idempotent and best-effort so it
 * never masks the run's real outcome from a `finally`. */
export function stop_sandbox(handle: SandboxHandle, log?: (message: string) => void): void {
  try {
    docker(['rm', '-f', handle.container], DOCKER_ADMIN_TIMEOUT_MS);
    log?.(`sandbox: removed container ${handle.container}`);
  } catch {
    // Teardown is cleanup; a lingering container never fails the run.
  }
}

export type SandboxOptions = {
  enabled: boolean;
  image: string;
  build_root: string;
  run_id: string;
  /** Egress posture (D6/D12); defaults to the default-deny `'none'`. */
  network?: SandboxNetwork;
  log?: (message: string) => void;
};

/**
 * Run `body` with the run's container lifecycle around it, handing it the `bash`
 * executor to wire into the builder tools: `docker exec` when enabled (start
 * first, guaranteed teardown in a `finally`), or `null` when disabled — a
 * transparent pass-through so the unsandboxed path (`--allow-unsandboxed-builder`,
 * shape C) keeps the host `spawnSync` executor and never touches Docker.
 */
export async function with_sandbox<T>(
  options: SandboxOptions,
  body: (bash_executor: BashExecutor | null) => Promise<T>,
): Promise<T> {
  if (!options.enabled) {
    return body(null);
  }
  const handle = start_sandbox({
    image: options.image,
    build_root: options.build_root,
    run_id: options.run_id,
    network: options.network ?? 'none',
    ...(options.log !== undefined ? { log: options.log } : {}),
  });
  try {
    return await body(docker_exec_bash(handle));
  } finally {
    stop_sandbox(handle, options.log);
  }
}
