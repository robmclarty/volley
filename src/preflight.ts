/**
 * `--dry-run` preflight (s2 Phase 2c; D1/D6/D7/D10, D9, B′): prove a run can
 * proceed *before any model spend*. It always renders the resolved config and,
 * when checkride is the resolved check, runs `checkride doctor`.
 *
 * For a containment-requiring local builder — run from *inside* its container
 * (B′-2) — it additionally checks the three things that contained build needs:
 * the toolchain is present, the worktree is creatable, and the host LLM endpoint
 * is reachable across the boundary at `host.docker.internal` (the resolved base
 * URL, which the v0.3.1 normalizer already crosses to the gateway when
 * `VOLLEY_MODEL_HOST` is set — engine.ts, OQ-8). Any containment check failing
 * exits 5 (`EXIT_CONFIG_ERROR`).
 *
 * The all-Claude path runs *none* of the containment checks — it never requires
 * Docker (C4) — so those checks never contribute an exit 5 on that path.
 *
 * The three probes are injectable so the exit-code contract is unit-testable
 * without a daemon, a git repo, or a live model endpoint.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_LMSTUDIO_URL,
  cross_to_host_gateway,
  resolve_ollama_base_url,
} from './engine.js';
import { EXIT_CONFIG_ERROR, EXIT_SUCCESS } from './exit_codes.js';
import type { Renderer } from './render/renderer.js';
import type { BuilderProvider, ResolvedConfig } from './types.js';

/** Executables the in-container builder shells out to (checkride/pnpm invoke
 * node; git drives the worktree). Their presence proves the sandbox image
 * carries the toolchain (Dockerfile). */
const REQUIRED_TOOLCHAIN: ReadonlyArray<string> = ['node', 'pnpm', 'git'];

/** A short cap on the endpoint probe so a wrong/unreachable host fails fast
 * rather than hanging the preflight before the loop even starts. */
const ENDPOINT_PROBE_TIMEOUT_MS = 3000;

/** Builders that run a local model through volley's own tool loop, so the
 * containment preflight applies. `claude_cli` never does (C4). */
export function is_local_builder(
  provider: BuilderProvider,
): provider is 'ollama' | 'lmstudio' {
  return provider === 'ollama' || provider === 'lmstudio';
}

/** The base URL the in-container model client will use — mirrors engine.ts's
 * `local_provider_config` so the preflight probes exactly what the run will hit.
 * With `VOLLEY_MODEL_HOST` set (B′-2) both cross a loopback authority to the host
 * gateway, so this is the `host.docker.internal` endpoint the done-when names. */
export function model_endpoint(
  provider: 'ollama' | 'lmstudio',
  env: Record<string, string | undefined>,
): string {
  if (provider === 'ollama') return resolve_ollama_base_url(env);
  const lmstudio_url = env['VOLLEY_LMSTUDIO_URL'] ?? DEFAULT_LMSTUDIO_URL;
  return cross_to_host_gateway(lmstudio_url, env);
}

/** Which required executables are not runnable on the current PATH. */
export function toolchain_missing(tools: ReadonlyArray<string> = REQUIRED_TOOLCHAIN): string[] {
  return tools.filter((tool) => {
    const result = spawnSync(tool, ['--version'], { stdio: 'ignore' });
    return result.error !== undefined || result.status !== 0;
  });
}

/** Non-destructive check that a git worktree could be created here: git runs and
 * `workspace` is a git work tree. Does not create anything (create/rotate is the
 * run's job — worktree.ts). */
export function worktree_creatable(workspace: string): { ok: boolean; detail: string } {
  const repo = resolve(workspace);
  const version = spawnSync('git', ['--version'], { stdio: 'ignore' });
  if (version.error !== undefined || version.status !== 0) {
    return { ok: false, detail: 'git is not available' };
  }
  if (!existsSync(resolve(repo, '.git'))) {
    return { ok: false, detail: `${repo} is not a git repository` };
  }
  const inside = spawnSync('git', ['-C', repo, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
  });
  if (inside.status !== 0 || (inside.stdout ?? '').trim() !== 'true') {
    return { ok: false, detail: `${repo} is not a git work tree` };
  }
  return { ok: true, detail: repo };
}

/** Reachability probe: any HTTP response (even a 404) proves the TCP connect
 * landed; a thrown error (connection refused, DNS failure, timeout) means the
 * endpoint is unreachable. */
export async function endpoint_reachable(
  url: string,
  timeout_ms: number = ENDPOINT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeout_ms) });
    return true;
  } catch {
    return false;
  }
}

/** Injectable probes so the exit-code contract is testable without a daemon,
 * git, or a live endpoint; each defaults to the real implementation above. */
export type PreflightProbes = {
  toolchain_missing?: (tools?: ReadonlyArray<string>) => string[];
  worktree_creatable?: (workspace: string) => { ok: boolean; detail: string };
  endpoint_reachable?: (url: string) => Promise<boolean>;
  checkride_doctor?: (workspace: string) => boolean;
};

function run_checkride_doctor(workspace: string): boolean {
  const doctor = spawnSync('pnpm', ['exec', 'checkride', 'doctor'], {
    cwd: workspace,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return doctor.error === undefined && doctor.status === 0;
}

/**
 * Run the preflight and return its exit code (`EXIT_SUCCESS` or, on any failure,
 * `EXIT_CONFIG_ERROR` = 5). `env` supplies the endpoint crossing (`VOLLEY_MODEL_HOST`)
 * and matches what the run itself will read.
 */
export async function preflight(
  config: ResolvedConfig,
  renderer: Renderer,
  env: Record<string, string | undefined>,
  probes: PreflightProbes = {},
): Promise<number> {
  const provider = config.builder_provider;
  const local_builder = is_local_builder(provider);

  renderer.info(`dry run: config valid (run ${config.run_id})`);
  renderer.info(`workspace: ${config.workspace}`);
  renderer.info(`check: ${config.check} (resolved: ${config.check_resolved})`);
  renderer.info(`builder model: ${config.builder_model} (provider: ${config.builder_provider})`);
  renderer.info(`builder max steps: ${config.builder_max_steps}`);
  if (local_builder) {
    const contained = env['VOLLEY_CONTAINED'] === '1' || env['VOLLEY_CONTAINED'] === 'true';
    renderer.info(
      contained
        ? 'containment: inside the sandbox container (VOLLEY_CONTAINED)'
        : 'containment: uncontained on the host (--allow-unsandboxed-builder)',
    );
    renderer.info(`sandbox image: ${config.sandbox_image}`);
  }
  renderer.info(
    `critic: ${config.critic_preset}${config.critic_prompt_path !== null ? ` (${config.critic_prompt_path})` : ''}`,
  );
  renderer.info(`critic model: ${config.critic_model} (provider: ${config.critic_provider})`);

  if (config.check_resolved === 'checkride') {
    const doctor = probes.checkride_doctor ?? run_checkride_doctor;
    if (!doctor(config.workspace)) {
      renderer.error('checkride doctor failed; fix the workspace check pipeline before running');
      return EXIT_CONFIG_ERROR;
    }
    renderer.info('checkride doctor: ok');
  }

  // Containment preflight — local builder only, so the all-Claude path never
  // reaches an exit 5 from here (C4). Re-calling the guard narrows `provider`.
  if (!is_local_builder(provider)) return EXIT_SUCCESS;

  const missing = (probes.toolchain_missing ?? toolchain_missing)(REQUIRED_TOOLCHAIN);
  if (missing.length > 0) {
    renderer.error(`preflight: missing toolchain in the sandbox: ${missing.join(', ')}`);
    return EXIT_CONFIG_ERROR;
  }
  renderer.info(`toolchain: ${REQUIRED_TOOLCHAIN.join(', ')} present`);

  if (config.worktree) {
    const worktree = (probes.worktree_creatable ?? worktree_creatable)(config.workspace);
    if (!worktree.ok) {
      renderer.error(`preflight: worktree not creatable: ${worktree.detail}`);
      return EXIT_CONFIG_ERROR;
    }
    renderer.info(`worktree: creatable (${worktree.detail})`);
  }

  const endpoint = model_endpoint(provider, env);
  const reachable = await (probes.endpoint_reachable ?? endpoint_reachable)(endpoint);
  if (!reachable) {
    renderer.error(`preflight: host LLM endpoint unreachable: ${endpoint}`);
    return EXIT_CONFIG_ERROR;
  }
  renderer.info(`host LLM endpoint: reachable (${endpoint})`);

  return EXIT_SUCCESS;
}
