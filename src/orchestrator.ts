/**
 * Loop orchestration (spec §6): compose fascicle's `loop` from four thin
 * steps and execute it with a single `run` call. No hand-rolled runner —
 * rounds, abort threading, signal handlers, and cleanup order all belong to
 * the substrate.
 */
import { existsSync, readFileSync } from 'node:fs';
import { loop, run, sequence, step } from 'fascicle';
import { filesystem_logger } from 'fascicle/adapters';
import type { Engine } from 'fascicle';
import { run_builder } from './builder.js';
import { run_checkride } from './check/checkride.js';
import { run_command_check, skipped_check } from './check/command.js';
import { cost_cap_hit } from './cost.js';
import { EMPTY_USAGE } from './cost.js';
import { create_volley_engine } from './engine.js';
import {
  archive_iteration,
  run_result_from_state,
  write_run_summary,
} from './iteration.js';
import { run_critic } from './critic/run.js';
import type { Renderer } from './render/renderer.js';
import { error_kind, phase_error } from './types.js';
import type {
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
  volley_path,
  write_resolved_config,
} from './workspace.js';

export function initial_state(): LoopState {
  return {
    iteration: 0,
    iteration_started_at: new Date().toISOString(),
    feedback: null,
    verdict: null,
    unmet_criteria: [],
    check: null,
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

/** All three stopping conditions live here (spec §2): acceptance, cost cap,
 * and — implicitly via `max_rounds` — the iteration budget. Success wins
 * when it and the cap land on the same iteration. */
export function gate(
  config: ResolvedConfig,
  state: LoopState,
): { stop: boolean; state: LoopState } {
  const success = state.check?.ok === true && state.verdict === 'approved';
  const cap = cost_cap_hit(config, state);
  return {
    stop: success || cap,
    state: { ...state, halt: !success && cap ? 'cost_cap' : null },
  };
}

export function status_of(value: LoopState, converged: boolean): RunStatus {
  if (value.halt === 'cost_cap') return 'cost_cap_reached';
  return converged ? 'success' : 'budget_exhausted';
}

async function execute_check(
  config: ResolvedConfig,
  abort: AbortSignal,
): Promise<CheckResult> {
  if (config.check_resolved === 'checkride') {
    return run_checkride({ workspace: config.workspace, abort });
  }
  if (config.check_resolved === 'command') {
    return run_command_check({ command: config.check, workspace: config.workspace, abort });
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

  const engine =
    deps.engine ??
    create_volley_engine({
      workspace: config.workspace,
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
      { engine, config, on_chunk: renderer.builder_chunk },
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
    if (config.git_checkpoints) {
      git_checkpoint(config.workspace, `volley iter ${String(built.iteration)}: build`);
    }
    return built;
  });

  // A builder-crossed cap short-circuits to the guard: the check and critic
  // are skipped so a doomed iteration spends nothing more (spec §6).
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
    write_run_summary(
      config.workspace,
      run_result_from_state(config, s, 'running', null),
    );
    if (config.git_checkpoints) {
      git_checkpoint(
        config.workspace,
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
    write_run_summary(config.workspace, result);
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
    write_run_summary(config.workspace, {
      ...prior,
      status,
      completed_at: new Date().toISOString(),
    });
  } catch {
    // Never mask the original failure with a bookkeeping error.
  }
}
