/**
 * The step bodies behind the nodes of `./flow.ts`, one function per node. Each
 * takes the loop's carry-state and returns the next one. The phase modules they
 * call (`./builder.ts`, `./check/`, `./critic/`) do the work; these bodies add
 * what surrounds it: the renderer lines an operator watches, change detection,
 * git checkpoints, and the per-iteration archive.
 */
import type { Engine, RunContext } from 'fascicle';
import { run_builder } from './builder.js';
import type { BashExecutor } from './builder/tools.js';
import { collect_changes } from './changes.js';
import { run_checkride } from './check/checkride.js';
import { run_command_check, skipped_check } from './check/command.js';
import { run_critic } from './critic/run.js';
import { archive_iteration, run_result_from_state } from './iteration.js';
import type { Renderer } from './render/renderer.js';
import { write_run_summary } from './summary.js';
import { error_kind, phase_error } from './types.js';
import type { ChangeSet, CheckResult, LoopState, ResolvedConfig } from './types.js';
import { git_checkpoint } from './workspace.js';
import { build_root } from './worktree.js';

/** What every step body closes over, fixed for the whole run. */
export type PhaseDeps = {
  engine: Engine;
  config: ResolvedConfig;
  renderer: Renderer;
  /** The local builder's `bash` executor, or null for the host `spawnSync`
   * default (and for `claude_cli`, which supplies no volley tools). */
  bash_executor: BashExecutor | null;
  /** The commit every iteration's change set is measured against, read after
   * the worktree exists and before the builder writes anything. Null when the
   * build root is not a git repo — then the run reports no changes at all
   * rather than guessing at them. */
  baseline: string | null;
};

/** How many gate edits a warning names before it summarises the rest. */
const LISTED_GATE_EDITS = 5;

/**
 * Say what the builder reached for, every iteration. The count is an info line;
 * a gate edit is a warning, because it is the fact that changes how much a green
 * check is worth — and the operator should hear it from the harness rather than
 * discover it in the diff afterwards (the by-hand check that
 * `research/reckon-local-run-finding.md` recommends making routine).
 */
function report_changes(
  config: ResolvedConfig,
  renderer: Renderer,
  changes: ChangeSet | null,
): void {
  if (changes === null) return;
  renderer.info(
    `changes: ${String(changes.total)} file(s) changed since the run baseline` +
      (changes.truncated ? ` (listing the first ${String(changes.files.length)})` : ''),
  );
  if (changes.gate_edits.length === 0) return;
  const hidden = changes.gate_edits.length - LISTED_GATE_EDITS;
  const listed = changes.gate_edits.slice(0, LISTED_GATE_EDITS).join(', ');
  renderer.warn(
    `gate edit: the builder changed ${String(changes.gate_edits.length)} file(s) that decide ` +
      `whether its work passes — ${listed}${hidden > 0 ? ` (+${String(hidden)} more)` : ''}. ` +
      'A green check proves less when the builder can edit the gate; the critic is told about ' +
      'this and the run summary records it.' +
      // The halt lands at the loop guard, after this iteration's check and
      // critic have had their say — so promise the outcome, not the timing.
      (config.fail_on_gate_edit
        ? ' This run will end without success (--fail-on-gate-edit, exit 8).'
        : ''),
  );
}

async function execute_check(
  config: ResolvedConfig,
  abort: AbortSignal,
): Promise<CheckResult> {
  // The check gates the tree the builder actually wrote: the worktree
  // under `--worktree`, else the workspace.
  const root = build_root(config.workspace, config.worktree);
  if (config.check_resolved === 'checkride') {
    return run_checkride({ workspace: root, abort });
  }
  if (config.check_resolved === 'command') {
    return run_command_check({ command: config.check, workspace: root, abort });
  }
  return skipped_check('none');
}

/** Open the next iteration: advance the counter and clear every per-iteration
 * field, so nothing from the last round leaks into this one. */
function next_iteration(s: LoopState): LoopState {
  return {
    ...s,
    iteration: s.iteration + 1,
    iteration_started_at: new Date().toISOString(),
    iteration_cost_usd: 0,
    builder: null,
    critic: null,
    check: null,
    verdict: null,
    unmet_criteria: [],
  };
}

/** `build`: one builder session edits the build root, then volley measures what
 * it changed and, under `--git`, checkpoints it. */
export async function build_phase(
  deps: PhaseDeps,
  s: LoopState,
  ctx: RunContext,
): Promise<LoopState> {
  const { config, renderer } = deps;
  const next = next_iteration(s);
  renderer.phase_start(next.iteration, 'builder');
  const built = await run_builder(
    {
      engine: deps.engine,
      config,
      on_chunk: renderer.builder_chunk,
      warn: renderer.warn,
      bash_executor: deps.bash_executor,
    },
    next,
    ctx,
  );
  renderer.phase_end(built.iteration, 'builder', true);
  renderer.cost_line(
    built.iteration,
    'builder',
    built.builder?.cost_usd ?? null,
    built.total_cost_usd,
  );
  if (built.cost_warned && !s.cost_warned) {
    renderer.warn('cost unavailable for this phase; recording null (run totals sum what is known)');
  }
  // What the builder actually did, measured before the check runs — so the
  // check's verdict and the builder's reach are two independent facts about
  // the same iteration rather than one inferred from the other.
  const changes = collect_changes({
    root: build_root(config.workspace, config.worktree),
    baseline: deps.baseline,
    gate_patterns: config.gate_paths,
  });
  report_changes(config, renderer, changes);
  if (config.git_checkpoints) {
    git_checkpoint(
      build_root(config.workspace, config.worktree),
      `volley iter ${String(built.iteration)}: build`,
    );
  }
  return { ...built, changes };
}

/** `skip_verify`: the build alone crossed the cost cap, so the check is recorded
 * as skipped and no critic is called — a doomed iteration spends nothing more.
 * The loop guard then halts the run on the cap. */
export function skip_verify_phase(deps: PhaseDeps, s: LoopState): LoopState {
  deps.renderer.warn('cost cap crossed during build; skipping check and critic');
  return { ...s, check: skipped_check('cost_cap') };
}

/** `check`: the deterministic gate over the tree the builder wrote. */
export async function check_phase(
  deps: PhaseDeps,
  s: LoopState,
  ctx: RunContext,
): Promise<LoopState> {
  const { config, renderer } = deps;
  renderer.phase_start(s.iteration, 'check');
  try {
    const result = await execute_check(config, ctx.abort);
    if (result.ran) {
      renderer.phase_end(
        s.iteration,
        'check',
        result.ok,
        result.failing_slots.length > 0
          ? `failing: ${result.failing_slots.join(', ')}`
          : undefined,
      );
    } else {
      renderer.info('no deterministic check configured; loop is critic-gated only');
    }
    return {
      ...s,
      check: result,
      check_duration_ms: s.check_duration_ms + result.duration_ms,
    };
  } catch (err) {
    if (error_kind(err) === 'check_error') throw err;
    throw phase_error('check', s.iteration, err);
  }
}

/** `critique`: the read-only critic's verdict, feedback, and unmet criteria. */
export async function critique_phase(
  deps: PhaseDeps,
  s: LoopState,
  ctx: RunContext,
): Promise<LoopState> {
  const { renderer } = deps;
  renderer.phase_start(s.iteration, 'critic');
  const critiqued = await run_critic(
    { engine: deps.engine, config: deps.config, on_chunk: renderer.critic_chunk },
    s,
    ctx,
  );
  renderer.phase_end(
    critiqued.iteration,
    'critic',
    critiqued.verdict === 'approved',
    critiqued.verdict ?? undefined,
  );
  renderer.cost_line(
    critiqued.iteration,
    'critic',
    critiqued.critic?.cost_usd ?? null,
    critiqued.total_cost_usd,
  );
  return critiqued;
}

/** `record`: archive the iteration and rewrite the run summary, so the on-disk
 * state is consistent after every round (resume reads it back). */
export function record_phase(deps: PhaseDeps, s: LoopState): LoopState {
  const { config } = deps;
  archive_iteration(config, s);
  write_run_summary(config, run_result_from_state(config, s, 'running', null));
  if (config.git_checkpoints) {
    git_checkpoint(
      build_root(config.workspace, config.worktree),
      `volley iter ${String(s.iteration)}: critique (${s.verdict ?? 'skipped'})`,
    );
  }
  return s;
}
