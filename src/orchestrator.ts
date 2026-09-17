/**
 * Loop orchestration: compose fascicle's `loop` from four thin
 * steps and execute it with a single `run` call. No hand-rolled runner —
 * rounds, abort threading, signal handlers, and cleanup order all belong to
 * the substrate.
 */
import { existsSync, readFileSync } from 'node:fs';
import { loop, run, sequence, step } from 'fascicle';
import { filesystem_logger } from 'fascicle/adapters';
import type { Engine } from 'fascicle';
import { run_builder } from './builder.js';
import type { BashExecutor } from './builder/tools.js';
import { capture_baseline, collect_changes } from './changes.js';
import { run_checkride } from './check/checkride.js';
import { run_command_check, skipped_check } from './check/command.js';
import { cost_cap_hit } from './cost.js';
import { EMPTY_USAGE } from './cost.js';
import { create_volley_engine } from './engine.js';
import { archive_iteration, run_result_from_state } from './iteration.js';
import { write_run_summary } from './summary.js';
import { run_critic } from './critic/run.js';
import type { Renderer } from './render/renderer.js';
import { error_kind, phase_error } from './types.js';
import type {
  ChangeSet,
  CheckResult,
  LoopState,
  ResolvedConfig,
  RunInput,
  RunResult,
  RunStatus,
} from './types.js';
import {
  git_checkpoint,
  initialize_workspace,
  integrate_worktree,
  volley_path,
  write_resolved_config,
} from './workspace.js';
import {
  build_root,
  report_worktree_fate,
  with_worktree,
  worktree_branch,
  worktree_fate,
} from './worktree.js';

export function initial_state(): LoopState {
  return {
    iteration: 0,
    iteration_started_at: new Date().toISOString(),
    feedback: null,
    verdict: null,
    unmet_criteria: [],
    check: null,
    changes: null,
    builder: null,
    critic: null,
    total_usage: EMPTY_USAGE,
    total_cost_usd: 0,
    builder_cost_usd: 0,
    critic_cost_usd: 0,
    check_duration_ms: 0,
    iteration_cost_usd: 0,
    halt: null,
    cost_warned: false,
  };
}

/** Did this iteration's builder edit the gate that judges it, with the operator
 * having asked for that to stop the run? Reported either way (the critic prompt
 * and the summary always carry it); only `--fail-on-gate-edit` makes it fatal. */
function gate_edit_halt(config: ResolvedConfig, state: LoopState): boolean {
  return config.fail_on_gate_edit && (state.changes?.gate_edits.length ?? 0) > 0;
}

/** All stopping conditions live here: acceptance, cost cap, the gate
 * edit refusal, and — implicitly via `max_rounds` — the iteration budget.
 * Success wins when it and the cap land on the same iteration.
 *
 * A gate edit is the one condition that *beats* success rather than losing to
 * it: the run passed a check the builder had rewritten, so the pass is exactly
 * what is in question. It stops the run instead of iterating, because a model
 * that just edited the gate is not a promising candidate to be asked again. */
export function gate(
  config: ResolvedConfig,
  state: LoopState,
): { stop: boolean; state: LoopState } {
  const gate_edit = gate_edit_halt(config, state);
  const success = state.check?.ok === true && state.verdict === 'approved' && !gate_edit;
  const cap = cost_cap_hit(config, state);
  const halt = gate_edit ? 'gate_edit' : !success && cap ? 'cost_cap' : null;
  return {
    stop: success || cap || gate_edit,
    state: { ...state, halt },
  };
}

export function status_of(value: LoopState, converged: boolean): RunStatus {
  if (value.halt === 'gate_edit') return 'gate_edit_blocked';
  if (value.halt === 'cost_cap') return 'cost_cap_reached';
  return converged ? 'success' : 'budget_exhausted';
}

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

export type OrchestratorDeps = {
  renderer: Renderer;
  engine?: Engine;
  abort?: AbortSignal;
  install_signal_handlers?: boolean;
};

export type RunOutcome = {
  result: RunResult;
  status: RunStatus;
};

export async function run_volley(
  config: ResolvedConfig,
  deps: OrchestratorDeps,
  resume_from: LoopState | null = null,
): Promise<RunResult> {
  const { renderer } = deps;

  if (resume_from === null) {
    initialize_workspace(config.workspace);
    write_resolved_config(config);
  } else {
    initialize_workspace(config.workspace, { preserve: true });
  }

  // Say what this run will do with its effects before it spends anything — the
  // same notice `--dry-run` prints, repeated here so a run started without a dry
  // run still hears it (the same predict-then-warn shape).
  report_worktree_fate(config, renderer);

  // The worktree lifecycle wraps the whole builder loop: created before the
  // first iteration, torn down after the last. Off unless `--worktree` is set
  // (config.worktree), so the default path never touches git here.
  const branch = worktree_branch(config.run_id);
  const fate = worktree_fate(config);
  const outcome = await with_worktree<RunResult>(
    {
      enabled: config.worktree,
      workspace: config.workspace,
      branch,
      log: (message) => renderer.info(message),
      // The one case teardown must keep rather than force-delete: a converged run
      // that integrated nothing, whose only copy of its work is the worktree.
      salvage: (result) => fate === 'salvage' && result.status === 'success',
    },
    async () => {
      // Whole-process containment: volley runs *inside* its hardened
      // container already — the operator/example's `docker run … <volley args>`
      // launched it — so there is no container lifecycle to orchestrate here. `bash`
      // is the local `host_bash_executor` running in-container (null executor,
      // the host `spawnSync` default) and the file tools write straight to the
      // bind-mounted worktree; the retired `docker exec` path is gone. The
      // hardened `docker run` invocation spec the example uses lives in
      // `src/sandbox.ts`.
      // The commit every iteration's change set is measured against, read after
      // the worktree exists and before the builder writes anything. Null when the
      // build root is not a git repo — then the run reports no changes at all
      // rather than guessing at them.
      const baseline = capture_baseline(build_root(config.workspace, config.worktree));
      const result = await run_loop(config, deps, resume_from, null, baseline);
      // Integration: a *successful* `--worktree --git` run squash-merges the
      // phase branch's checkpoints onto the workspace branch before teardown
      // discards it. Any non-success outcome (cost cap, budget, interrupt,
      // error) is abandoned — teardown discards the branch wholesale, nothing
      // integrated. Gated on `--git` too (`fate === 'integrate'`), so volley only
      // commits to the workspace branch when the operator opted into checkpoints;
      // without it the same work is salvaged onto its own branch instead.
      if (fate === 'integrate' && result.status === 'success') {
        integrate_worktree(config.workspace, branch, `volley run ${config.run_id}: integrate worktree (squash)`);
        renderer.info(`worktree: squash-merged ${branch} onto the workspace branch`);
      }
      return result;
    },
  );

  if (outcome.kept_path !== null) {
    renderer.warn(
      `worktree: could not commit this run's work onto ${branch}, so the checkout at ` +
        `${outcome.kept_path} was left standing rather than deleted — its files are intact, and ` +
        'the next --worktree run rotates the directory aside instead of destroying it.',
    );
  }
  if (outcome.salvaged_branch === null) return outcome.value;
  renderer.info(
    `worktree: this run was not integrated; its work is preserved on branch ` +
      `${outcome.salvaged_branch} (git switch ${outcome.salvaged_branch}, or cherry-pick it).`,
  );
  // Teardown salvaged the branch *after* `run_loop` wrote the final summary, so
  // re-stamp it: `.volley/summary.json` and `--json` both name the survivor.
  const salvaged: RunResult = { ...outcome.value, salvaged_branch: outcome.salvaged_branch };
  write_run_summary(config, salvaged);
  return salvaged;
}

async function run_loop(
  config: ResolvedConfig,
  deps: OrchestratorDeps,
  resume_from: LoopState | null,
  bash_executor: BashExecutor | null,
  baseline: string | null,
): Promise<RunResult> {
  const { renderer } = deps;

  const engine =
    deps.engine ??
    create_volley_engine({
      workspace: config.workspace,
      builder_provider: config.builder_provider,
      critic_provider: config.critic_provider,
    });

  const build = step('build', async (s: LoopState, ctx) => {
    const next: LoopState = {
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
    renderer.phase_start(next.iteration, 'builder');
    const built = await run_builder(
      { engine, config, on_chunk: renderer.builder_chunk, warn: renderer.warn, bash_executor },
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
      baseline,
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
  });

  // A builder-crossed cap short-circuits to the guard: the check and critic
  // are skipped so a doomed iteration spends nothing more.
  const check = step('check', async (s: LoopState, ctx) => {
    if (cost_cap_hit(config, s)) {
      renderer.warn('cost cap crossed during build; skipping check and critic');
      return { ...s, check: skipped_check('cost_cap') };
    }
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
  });

  const critique = step('critique', async (s: LoopState, ctx) => {
    if (s.check !== null && !s.check.ran && cost_cap_hit(config, s)) {
      return s;
    }
    renderer.phase_start(s.iteration, 'critic');
    const critiqued = await run_critic(
      { engine, config, on_chunk: renderer.critic_chunk },
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
  });

  const record = step('record', (s: LoopState) => {
    archive_iteration(config, s);
    write_run_summary(config, run_result_from_state(config, s, 'running', null));
    if (config.git_checkpoints) {
      git_checkpoint(
        build_root(config.workspace, config.worktree),
        `volley iter ${String(s.iteration)}: critique (${s.verdict ?? 'skipped'})`,
      );
    }
    return s;
  });

  const flow = loop<RunInput, LoopState, LoopState>({
    name: 'volley',
    init: (input) => input.resume_from ?? initial_state(),
    body: sequence([build, check, critique, record]),
    guard: step('gate', (s: LoopState) => gate(config, s)),
    finish: (s) => s,
    max_rounds: config.max_iterations - (resume_from?.iteration ?? 0),
  });

  try {
    const { value, converged } = await run(
      flow,
      { resume_from },
      {
        trajectory: filesystem_logger({
          output_path: volley_path(config.workspace, 'trajectory.jsonl'),
        }),
        ...(deps.abort !== undefined ? { abort: deps.abort } : {}),
        ...(deps.install_signal_handlers !== undefined
          ? { install_signal_handlers: deps.install_signal_handlers }
          : {}),
      },
    );
    const status = status_of(value, converged);
    const result = run_result_from_state(config, value, status, new Date().toISOString());
    write_run_summary(config, result);
    return result;
  } catch (err) {
    finalize_failed_run(config, err);
    throw err;
  } finally {
    await engine.dispose();
  }
}

/** Best-effort status stamp on the run summary when the loop threw; the
 * on-disk iteration state is already consistent (record runs per round). */
function finalize_failed_run(config: ResolvedConfig, err: unknown): void {
  const kind = error_kind(err);
  const cause = kind === 'phase_error' ? error_kind((err as { cause?: unknown }).cause) : null;
  const status: RunStatus =
    kind === 'aborted_error' || cause === 'aborted_error' ? 'interrupted' : 'error';
  try {
    // Preserve accumulated totals when `record` already wrote a summary.
    const summary_path = volley_path(config.workspace, 'summary.json');
    const prior = existsSync(summary_path)
      ? (JSON.parse(readFileSync(summary_path, 'utf8')) as RunResult)
      : run_result_from_state(config, initial_state(), status, null);
    write_run_summary(config, {
      ...prior,
      status,
      completed_at: new Date().toISOString(),
    });
  } catch {
    // Never mask the original failure with a bookkeeping error.
  }
}
