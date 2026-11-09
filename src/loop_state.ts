/**
 * The loop's carry-state across its life: the fresh state a run starts from,
 * the stopping rule the loop guard applies after every iteration, and the run
 * status the final state resolves to. Pure functions over `LoopState`; the
 * flow (`./flow.ts`) plugs them in.
 */
import { cost_cap_hit, EMPTY_USAGE } from './cost.js';
import type { ClimbReason, EffortRung, LoopState, ResolvedConfig, RunStatus } from './types.js';

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
    tester: null,
    tester_check: null,
    tester_changes: null,
    tester_hashes: {},
    total_usage: EMPTY_USAGE,
    total_cost_usd: 0,
    builder_cost_usd: 0,
    critic_cost_usd: 0,
    tester_cost_usd: 0,
    check_duration_ms: 0,
    builder_max_steps_hits: 0,
    builds: 0,
    rung: null,
    climbed: null,
    iteration_cost_usd: 0,
    halt: null,
    cost_warned: false,
  };
}

/** The effort build `build` (counted from 1) runs at: one rung further up the
 * ladder per build before it, the top rung repeating once it's reached. Null
 * with no ladder, which passes no effort at all. */
export function rung_for_build(ladder: ReadonlyArray<EffortRung> | null, build: number): EffortRung | null {
  if (ladder === null || ladder.length === 0) return null;
  return ladder[Math.min(Math.max(build, 1), ladder.length) - 1] ?? null;
}

/** Why build `build` runs a rung above the build before it, read off the state
 * that build left (`previous`). That build didn't end the run, so its check
 * failed or the critic sent it back: a check that didn't fail means the critic,
 * which is also how a resumed run reads it, since a resume keeps the last
 * check but not the last verdict. Null when it doesn't climb, because it's the
 * first build, the ladder's top has been reached, or there is no ladder. */
export function climb_reason(
  ladder: ReadonlyArray<EffortRung> | null,
  build: number,
  previous: LoopState,
): ClimbReason | null {
  if (ladder === null || build < 2 || build > ladder.length) return null;
  return previous.check?.ok === false ? 'check_failed' : 'critic_rejected';
}

/** Whether the tester opens the iteration after `s`: it's on, and this is the
 * run's first (move 1's D17). A run resumed before iteration 1 completed runs
 * it again. */
export function tester_opens(config: ResolvedConfig, s: LoopState): boolean {
  return config.tester && s.iteration === 0;
}

/** Whether the test phase opened this iteration and no build has run in it
 * yet: the tester ran, and the run has started no build. The build then works
 * in the iteration the tester opened rather than opening the next. */
export function tester_opened(s: LoopState): boolean {
  return s.tester !== null && s.builds === 0;
}

/** Whether the check passed right after the tester, before any build. A check
 * skipped for the cost cap didn't run, so it never counts. */
export function tester_passed_early(s: LoopState): boolean {
  return tester_opened(s) && s.tester_check?.ran === true && s.tester_check.ok;
}

/** How many rounds the loop may still run: the whole budget on a fresh run, what
 * the resumed run's completed iterations left of it otherwise. */
export function remaining_iterations(
  config: ResolvedConfig,
  resume_from: LoopState | null,
): number {
  return config.max_iterations - (resume_from?.iteration ?? 0);
}

/** Did this iteration's builder edit the gate that judges it, with the operator
 * having asked for that to stop the run? Reported either way (the critic prompt
 * and the summary always carry it); only `--fail-on-gate-edit` makes it fatal. */
function gate_edit_halt(config: ResolvedConfig, state: LoopState): boolean {
  return config.fail_on_gate_edit && (state.changes?.gate_edits.length ?? 0) > 0;
}

/** All stopping conditions live here: acceptance, cost cap, the gate
 * edit refusal, a tester's test passing before any build, and — implicitly
 * via `max_rounds` — the iteration budget.
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
  const passed_early = tester_passed_early(state);
  const halt = gate_edit
    ? 'gate_edit'
    : passed_early
      ? 'tester_passed_early'
      : !success && cap
        ? 'cost_cap'
        : null;
  return {
    stop: success || cap || gate_edit || passed_early,
    state: { ...state, halt },
  };
}

export function status_of(value: LoopState, converged: boolean): RunStatus {
  if (value.halt === 'gate_edit') return 'gate_edit_blocked';
  if (value.halt === 'tester_passed_early') return 'tester_passed_early';
  if (value.halt === 'cost_cap') return 'cost_cap_reached';
  return converged ? 'success' : 'budget_exhausted';
}
