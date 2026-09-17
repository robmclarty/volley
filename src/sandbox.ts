/**
 * Docker sandbox invocation spec: the hardened
 * `docker run` argv that launches the *whole* volley builder inside one
 * container. volley no longer orchestrates the container — instead
 * the operator/example runs `docker run <these flags> <image> <volley args>` and
 * volley detects it is already contained. The create/`exec`/reap/teardown
 * lifecycle and the `docker exec` bash executor were retired; what
 * remains here is the *spec* — pure, daemon-free flag-builders the blessed
 * examples and the `--dry-run` preflight render into the `docker run` line,
 * unit-testable without a daemon.
 *
 * Inside that container volley's `bash` is the local `host_bash_executor`
 * (`spawnSync`, now running in-container), its file tools write straight to the
 * bind-mounted worktree at `/workspace`, and its model client reaches the host
 * LLM endpoint across the boundary at `host.docker.internal` (the allowlist
 * target; see the `VOLLEY_MODEL_HOST` crossing in `src/engine.ts`).
 *
 * Hardening: non-root as the worktree owner, cap-drop-all,
 * no-new-privileges, default seccomp, tini as PID 1 (`--init`), memory/cpu/pids
 * caps, a read-only rootfs with tmpfs for the few writable paths, and the pnpm
 * store on a named volume. Never `--privileged`, never `--user 0`. volley's Node
 * process reaps its own bash children in-container, so the old reap-between-`exec`
 * rider falls away.
 */
import { resolve } from 'node:path';
import { config_error } from './types.js';

/** The in-container mount point for the bind-mounted worktree; matches the
 * `Dockerfile`'s `WORKDIR`, so a workspace-relative path resolves against the
 * same tree volley's file tools write. */
const SANDBOX_WORKDIR = '/workspace';

/** The container user's home; matches the `Dockerfile`'s `node` user. `HOME` is
 * pinned here (a numeric `--user` has no `/etc/passwd` entry, so `~` is
 * otherwise unset) and its `.cache` is a tmpfs so the read-only rootfs does not
 * brick tools that scribble there. */
const SANDBOX_HOME = '/home/node';

/** Named volume for the pnpm store: survives the read-only rootfs and
 * persists the content-addressed store across runs. (Making a `--user`-mapped,
 * non-1000 uid writable to a fresh volume is a footgun handled where pnpm
 * actually runs — the blessed examples — not here.) */
const SANDBOX_STORE_VOLUME = 'volley-pnpm-store';

/** The host spelling of the Docker gateway (Linux-portable; Docker Desktop
 * already provides it). It is both the `--add-host` target for the allowlist
 * bridge and the value the example injects as `VOLLEY_MODEL_HOST` so the
 * in-container model client crosses to the host LLM endpoint (see
 * `resolve_ollama_base_url` in `src/engine.ts`). */
export const HOST_GATEWAY_HOST = 'host.docker.internal';

/** Canonical identity of the allowlist bridge the examples create (`docker
 * network create --subnet <SANDBOX_NETWORK_SUBNET> <SANDBOX_NETWORK_NAME>`) and
 * the host `DOCKER-USER` rules scope to. Exported so the blessed examples
 * share one spelling of the invocation spec. */
export const SANDBOX_NETWORK_NAME = 'volley-sandbox-net';
export const SANDBOX_NETWORK_SUBNET = '172.31.99.0/24';

/**
 * The container's egress posture. Under whole-process containment
 * the model client and the `fetch` tool run inside the container, so its
 * legitimate egress is the package registry for `pnpm install` plus the host LLM
 * endpoint the model client reaches via host-gateway.
 *
 * - `'none'` — `--network none`: no interface at all, a complete L3 egress deny.
 *   The default-deny default; it fits a genuinely offline run where the model and
 *   deps are already in-container (a host-run model is unreachable under `none`).
 *   With the whole process in-container, `fetch` has no route either, so it
 *   degrades cleanly to a returned error result and the run continues.
 * - `'allowlist'` — the container sits on volley's dedicated user-defined bridge
 *   with `host.docker.internal:host-gateway`, collapsing the allowlist targets
 *   (the package registry, and the host LLM endpoint the in-container model
 *   client now reaches) onto the host gateway. The L3/L4 default-DROP that
 *   makes the bridge a true allowlist is the host-applied, subnet-scoped
 *   `DOCKER-USER` rule the operator installs (volley never installs it — that
 *   chain is root and host-global, and on Docker Desktop lives inside a VM). The
 *   always-on tool-level SSRF deny-list is the second, in-process defense-in-depth
 *   layer. Host hardening, run once as root on a Linux host, scoped to volley's
 *   subnet so it never touches other containers (insert ahead of the chain's
 *   terminating RETURN, in order):
 *     iptables -I DOCKER-USER -s 172.31.99.0/24 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
 *     iptables -I DOCKER-USER -s 172.31.99.0/24 -d <host-gateway-ip> -j ACCEPT   # collapsed allowlist
 *     iptables -I DOCKER-USER -s 172.31.99.0/24 -p udp --dport 53 -j ACCEPT      # DNS
 *     iptables -I DOCKER-USER -s 172.31.99.0/24 -j DROP                          # default-deny the rest
 */
export type SandboxNetwork = 'none' | 'allowlist';

/**
 * The network-related `docker run` args for a posture, pure and exported
 * so the policy is unit-testable without a daemon. `'none'` denies all egress
 * (`--network none`); `'allowlist'` attaches the dedicated user-defined bridge and
 * collapses the allowlist targets onto the host gateway (`host.docker.internal`,
 * the Linux-portable spelling — harmless where Docker Desktop already provides it).
 */
export function network_run_args(network: SandboxNetwork, network_name: string): string[] {
  if (network === 'none') return ['--network', 'none'];
  return ['--network', network_name, '--add-host', `${HOST_GATEWAY_HOST}:host-gateway`];
}

/**
 * The hardened `docker run` argv that launches volley inside its container.
 * Pure and exported so the flag set is unit-testable without a
 * daemon and the blessed examples / `--dry-run` preflight can render it.
 *
 * A one-shot, foreground `--rm` container — the whole run *is* this
 * container (an earlier design ran a detached `-d … sleep infinity` daemon volley
 * `exec`'d against), so `--rm` cleans it up when volley exits. `command`
 * appends the container command (the volley args); omit it to use the image's
 * `volley` entrypoint. `env` injects `-e KEY=VALUE` pairs (the `VOLLEY_MODEL_HOST`
 * crossing). `entrypoint` overrides the image entrypoint (the opt-in
 * real-docker isolation test runs a raw `sh` this way).
 *
 * Never emits `--privileged` and refuses `--user 0`: volley must not hand
 * the sandbox root or full capabilities. Everything writable under the
 * `--read-only` rootfs is an explicit tmpfs or volume; the bind-mounted worktree
 * is the one host-visible write path.
 */
export function sandbox_run_args(options: {
  image: string;
  build_root: string;
  uid: number | null;
  gid: number | null;
  store_volume: string;
  network: SandboxNetwork;
  network_name: string;
  name?: string | null;
  env?: ReadonlyArray<readonly [string, string]>;
  entrypoint?: string | null;
  command?: ReadonlyArray<string>;
}): string[] {
  if (options.uid === 0) {
    throw config_error('refusing to start the builder sandbox as root (uid 0)');
  }
  const user =
    options.uid !== null && options.gid !== null
      ? ['--user', `${String(options.uid)}:${String(options.gid)}`]
      : [];
  const name =
    options.name !== undefined && options.name !== null ? ['--name', options.name] : [];
  const entrypoint =
    options.entrypoint !== undefined && options.entrypoint !== null
      ? ['--entrypoint', options.entrypoint]
      : [];
  const env = (options.env ?? []).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  return [
    'run',
    // One-shot, foreground container: the whole run *is* this container, so
    // remove it when volley exits.
    '--rm',
    ...name,
    ...user,
    // Network policy: default-deny egress. `'none'` gives the container
    // no interface; `'allowlist'` puts it on the user-defined bridge and collapses
    // the allowlist targets onto the host gateway.
    ...network_run_args(options.network, options.network_name),
    // Resource caps: contain a runaway / fork-bomb / OOM without starving
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
    // Privilege caps: drop every capability, forbid privilege
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
    ...env,
    // The bind-mounted worktree (writable — a bind mount is exempt from
    // `--read-only`) and the persistent pnpm store.
    '-v',
    `${resolve(options.build_root)}:${SANDBOX_WORKDIR}`,
    '-v',
    `${options.store_volume}:${SANDBOX_HOME}/.local/share/pnpm/store`,
    '-w',
    SANDBOX_WORKDIR,
    ...entrypoint,
    options.image,
    ...(options.command ?? []),
  ];
}

/**
 * The small helper that surfaces the full invocation spec: compose the
 * hardened `docker run` argv with the canonical bridge + pnpm store and, when
 * crossing to a host-run model (the `'allowlist'` posture), the
 * `VOLLEY_MODEL_HOST` env the base-url normalizer consumes (engine.ts). The
 * operator/example runs this (`format_docker_run` renders it as a copy-paste
 * shell line); volley detects it is contained rather than running it itself.
 */
export function sandbox_invocation(options: {
  image: string;
  build_root: string;
  uid: number | null;
  gid: number | null;
  network: SandboxNetwork;
  command: ReadonlyArray<string>;
  name?: string | null;
  /** The host the in-container model client crosses to (e.g. `HOST_GATEWAY_HOST`)
   * — injected as `VOLLEY_MODEL_HOST`; omit for a fully-offline `'none'` run. */
  model_host?: string;
}): string[] {
  const env: ReadonlyArray<readonly [string, string]> =
    options.model_host !== undefined && options.model_host !== ''
      ? [['VOLLEY_MODEL_HOST', options.model_host]]
      : [];
  return sandbox_run_args({
    image: options.image,
    build_root: options.build_root,
    name: options.name ?? null,
    uid: options.uid,
    gid: options.gid,
    store_volume: SANDBOX_STORE_VOLUME,
    network: options.network,
    network_name: SANDBOX_NETWORK_NAME,
    env,
    command: options.command,
  });
}

/** Render a docker argv as a copy-pasteable shell line for the examples /
 * `--dry-run` preflight. Minimal POSIX quoting: single-quote any token with
 * whitespace or shell-special characters. */
export function format_docker_run(run_args: ReadonlyArray<string>): string {
  return ['docker', ...run_args].map(quote_shell_token).join(' ');
}

function quote_shell_token(token: string): string {
  if (token.length > 0 && /^[A-Za-z0-9_./:=@-]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}
