/**
 * `--dry-run` preflight: prove a run can
 * proceed *before any model spend*. It always renders the resolved config and,
 * when checkride is the resolved check, runs `checkride doctor`. Under
 * `--worktree` it also predicts what a successful run will do with its effects
 * (`report_worktree_fate`) — integrate, salvage onto the run branch, or
 * discard — so no fate arrives as a surprise at teardown.
 *
 * For a containment-requiring tool-loop builder (local or `openrouter`) — run
 * from *inside* its container — it additionally checks the two things that
 * contained build needs: the toolchain is present and the worktree is
 * creatable. Any containment check failing exits 5 (`EXIT_CONFIG_ERROR`).
 *
 * Every seat on a URL-taking provider then gets its model endpoint probed: each
 * seat's own resolved base URL (`seat_base_url`, which crosses a loopback
 * authority to the gateway when `VOLLEY_MODEL_HOST` is set — engine.ts), one
 * probe when both seats share a server. An unreachable endpoint exits 5 too.
 *
 * The all-Claude path runs *none* of the containment checks or probes — it
 * never requires Docker or a model server — so they never contribute an exit 5
 * on that path.
 *
 * A *local critic* additionally gets the critic-seat canary: one tiny $0
 * generate through the real critic tool wiring, run
 * whatever the builder provider is. A degradable failure warns and predicts
 * `critic_degraded`; only a would-fail-even-degraded combo (endpoint down,
 * model missing) exits 5. The `claude_cli` and `openrouter` critic paths never
 * run it: a canary that costs nothing on a local model costs money there.
 *
 * The probes are injectable so the exit-code contract is unit-testable without
 * a daemon, a git repo, or a live model endpoint.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { capture_baseline } from './changes.js';
import { critic_canary } from './critic/run.js';
import { create_volley_engine, seat_base_url, takes_seat_url } from './engine.js';
import type { Engine } from './engine.js';
import { EXIT_CONFIG_ERROR, EXIT_SUCCESS } from './exit_codes.js';
import type { Renderer } from './render/renderer.js';
import type { BuilderProvider, CriticProvider, ResolvedConfig } from './types.js';
import { run_state_dir } from './workspace.js';
import { build_root, report_worktree_fate } from './worktree.js';

/** Executables the in-container builder shells out to (checkride/pnpm invoke
 * node; git drives the worktree). Their presence proves the sandbox image
 * carries the toolchain (Dockerfile). */
const REQUIRED_TOOLCHAIN: ReadonlyArray<string> = ['node', 'pnpm', 'git'];

/** A short cap on the endpoint probe so a wrong/unreachable host fails fast
 * rather than hanging the preflight before the loop even starts. */
const ENDPOINT_PROBE_TIMEOUT_MS = 3000;

/** Builders that drive their model through volley's own tool loop, local or
 * hosted, so the containment preflight applies. `claude_cli` never does. */
export function is_tool_loop_builder(
  provider: BuilderProvider,
): provider is 'ollama' | 'lmstudio' | 'openrouter' {
  return provider !== 'claude_cli';
}

/** Critics that run a local model through volley's own tool wiring, so the
 * critic-seat canary applies. `claude_cli` never does: that path is
 * proven and its calls cost real money. Nor does `openrouter`, whose calls cost
 * money too. */
export function is_local_critic(
  provider: CriticProvider,
): provider is 'ollama' | 'lmstudio' {
  return provider === 'ollama' || provider === 'lmstudio';
}

/** One model server a seat (or both seats) will reach, and who reaches it. */
type SeatEndpoint = { seats: string; url: string };

/** The model endpoint each seat on a URL-taking provider will hit, resolved by
 * the same `seat_base_url` the run uses, so the preflight probes exactly what
 * the run will hit. Two seats on one server are merged into one endpoint, so
 * a shared server is probed once. */
function seat_endpoints(
  config: ResolvedConfig,
  env: Record<string, string | undefined>,
): SeatEndpoint[] {
  const builder = takes_seat_url(config.builder_provider)
    ? seat_base_url(config.builder_provider, config.builder_url, env)
    : null;
  const critic = takes_seat_url(config.critic_provider)
    ? seat_base_url(config.critic_provider, config.critic_url, env)
    : null;
  if (builder !== null && builder === critic) {
    return [{ seats: 'builder and critic', url: builder }];
  }
  return [
    ...(builder === null ? [] : [{ seats: 'builder', url: builder }]),
    ...(critic === null ? [] : [{ seats: 'critic', url: critic }]),
  ];
}

/** Probe each seat's model endpoint before any spend. False, after naming the
 * seat and the URL, when one is unreachable. */
async function probe_seat_endpoints(
  config: ResolvedConfig,
  renderer: Renderer,
  env: Record<string, string | undefined>,
  reachable: (url: string) => Promise<boolean>,
): Promise<boolean> {
  for (const { seats, url } of seat_endpoints(config, env)) {
    if (!(await reachable(url))) {
      renderer.error(`preflight: ${seats} model endpoint unreachable: ${url}`);
      return false;
    }
    renderer.info(`${seats} model endpoint: reachable (${url})`);
  }
  return true;
}

/** Which required executables are not runnable on the current PATH. */
function toolchain_missing(tools: ReadonlyArray<string> = REQUIRED_TOOLCHAIN): string[] {
  return tools.filter((tool) => {
    const result = spawnSync(tool, ['--version'], { stdio: 'ignore' });
    return result.error !== undefined || result.status !== 0;
  });
}

/** Non-destructive check that a git worktree could be created here: git runs and
 * `workspace` is a git work tree. Does not create anything (create/rotate is the
 * run's job — worktree.ts). */
function worktree_creatable(workspace: string): { ok: boolean; detail: string } {
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
async function endpoint_reachable(
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
 * git, or a live endpoint; each defaults to the real implementation above.
 * `canary_engine` fakes the *engine*, not the canary, so the tests exercise the
 * real two-rung classification in `critic_canary`. */
export type PreflightProbes = {
  toolchain_missing?: (tools?: ReadonlyArray<string>) => string[];
  worktree_creatable?: (workspace: string) => { ok: boolean; detail: string };
  endpoint_reachable?: (url: string) => Promise<boolean>;
  checkride_doctor?: (workspace: string) => boolean;
  canary_engine?: (
    config: ResolvedConfig,
    env: Record<string, string | undefined>,
  ) => Engine;
};

/** The canary drives the same engine construction the run itself uses, with the
 * critic role's provider wired in at the critic seat's URL; consulted only after
 * `is_local_critic` says the canary applies, so the claude_cli critic path never
 * builds an engine. */
function default_canary_engine(
  config: ResolvedConfig,
  env: Record<string, string | undefined>,
): Engine {
  return create_volley_engine({
    workspace: config.workspace,
    critic_provider: config.critic_provider,
    critic_url: config.critic_url,
    env,
  });
}

/** A seat's info line: its model and provider, and the endpoint a seat on a
 * URL-taking provider will reach. */
function seat_line(
  seat: 'builder' | 'critic',
  model: string,
  provider: BuilderProvider | CriticProvider,
  url: string | null,
  env: Record<string, string | undefined>,
): string {
  const endpoint = takes_seat_url(provider)
    ? `, endpoint: ${seat_base_url(provider, url, env)}`
    : '';
  return `${seat} model: ${model} (provider: ${provider}${endpoint})`;
}

/**
 * What this run will do about a builder that edits its own gate, said before any
 * spend — the same predict-then-warn shape as the worktree fate and the
 * critic-seat canary.
 *
 * The warning that earns its place here: `--fail-on-gate-edit` outside a git
 * repository is a refusal that cannot fire. Change detection needs a baseline to
 * diff against, so a non-git workspace silently reports nothing — and an
 * operator who asked for the refusal should learn that now, not from a summary
 * whose `gate_edits` is empty for the wrong reason.
 */
function report_gate_posture(config: ResolvedConfig, renderer: Renderer): void {
  const root = build_root(config.workspace, config.worktree);
  const detectable = capture_baseline(root) !== null || existsSync(join(root, '.git'));
  if (config.fail_on_gate_edit && !detectable) {
    renderer.warn(
      '--fail-on-gate-edit is set, but the build root is not a git repository, so there is no ' +
        'baseline to diff against and gate edits cannot be detected. The flag will not fire: ' +
        'run against a git workspace to get the refusal you asked for.',
    );
    return;
  }
  if (config.gate_paths.length === 0) {
    const edits = config.mode === 'critique' ? 'changes' : 'builder edits';
    renderer.info(`gate: no gate paths configured; ${edits} to tests and check config are not flagged.`);
    return;
  }
  renderer.info(
    `gate: watching ${String(config.gate_paths.length)} path pattern(s)` +
      (config.fail_on_gate_edit
        ? ' — a builder edit to any of them halts the run (--fail-on-gate-edit, exit 8).'
        : ' — edits are reported to the critic and recorded in the summary, not refused.'),
  );
}

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
  const tool_loop_builder = is_tool_loop_builder(config.builder_provider);

  renderer.info(`dry run: config valid (run ${config.run_id})`);
  renderer.info(`workspace: ${config.workspace}`);
  // Each run gets its own directory under the root; a dry run creates none.
  renderer.info(
    config.state_dir === null ? `state: ${run_state_dir(config)}` : `state root: ${config.state_dir}`,
  );
  renderer.info(`check: ${config.check} (resolved: ${config.check_resolved})`);
  if (config.mode === 'critique') {
    renderer.info('builder: none (a critique checks and critiques the change once)');
  } else {
    renderer.info(
      seat_line('builder', config.builder_model, config.builder_provider, config.builder_url, env),
    );
    renderer.info(`builder max steps: ${config.builder_max_steps}`);
    renderer.info(`builder tool calls per turn: ${config.builder_max_tool_calls}`);
  }
  if (tool_loop_builder) {
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
  renderer.info(
    seat_line('critic', config.critic_model, config.critic_provider, config.critic_url, env),
  );
  // What a successful run does with its effects, predicted here for any
  // builder provider — the worktree's fate is not a containment concern, and
  // `--worktree` without `--git` must not quietly end in a discarded build.
  report_worktree_fate(config, renderer);
  report_gate_posture(config, renderer);

  if (config.check_resolved === 'checkride') {
    const doctor = probes.checkride_doctor ?? run_checkride_doctor;
    if (!doctor(config.workspace)) {
      renderer.error('checkride doctor failed; fix the workspace check pipeline before running');
      return EXIT_CONFIG_ERROR;
    }
    renderer.info('checkride doctor: ok');
  }

  // Containment preflight — tool-loop builder only, so the all-Claude path
  // never reaches an exit 5 from here.
  if (tool_loop_builder) {
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
  }

  // Each URL-taking seat's own model endpoint, whatever the other seat runs on,
  // so a critic on a second machine is checked as surely as the builder's
  // server. The all-Claude path has no endpoint to probe.
  const reachable = probes.endpoint_reachable ?? endpoint_reachable;
  if (!(await probe_seat_endpoints(config, renderer, env, reachable))) {
    return EXIT_CONFIG_ERROR;
  }

  // Critic-seat canary — local critic only, whatever the
  // builder provider is, so a claude_cli-builder + local-critic run still gets
  // its doomed-combo warning before any builder spend. A degradable death warns
  // and predicts `critic_degraded` (refusing it would contradict the fallback
  // ladder); only a would-fail-even-degraded combo exits 5, named model×seat.
  if (is_local_critic(config.critic_provider)) {
    const engine = (probes.canary_engine ?? default_canary_engine)(config, env);
    const seat = `model '${config.critic_model}' in the critic seat (provider: ${config.critic_provider})`;
    try {
      const canary = await critic_canary(engine, config, env);
      if (canary.outcome === 'failed') {
        renderer.error(`preflight: critic canary failed — ${seat}: ${canary.detail}`);
        return EXIT_CONFIG_ERROR;
      }
      if (canary.outcome === 'degraded') {
        renderer.warn(
          `critic canary: ${seat} died on the tool-bearing call (${canary.detail}) ` +
            'but survived tool-less; a real run will likely degrade to the ' +
            'tool-less fallback and be marked critic_degraded',
        );
      } else {
        renderer.info(`critic canary: ok (${seat} answered through the real tool wiring)`);
      }
    } finally {
      await engine.dispose();
    }
  }

  return EXIT_SUCCESS;
}
