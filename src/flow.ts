/**
 * The volley flow: the whole topology of one run, and nothing else. Step bodies
 * live in `./phases.ts`, the stopping rule in `./loop_state.ts`, and the shell
 * around the flow (workspace setup, the worktree lifecycle, `run`, the final
 * summary) in `./orchestrator.ts`.
 *
 *   volley                        loop, one round per iteration, up to max_iterations
 *   │  init                       the resumed run's state, or a fresh one
 *   ├─ iteration                  sequence
 *   │  ├─ build                   a builder session edits the build root; volley measures the change
 *   │  ├─ verify                  branch: did the build alone cross the cost cap?
 *   │  │  ├─ then  skip_verify    record the check as skipped and call no critic
 *   │  │  └─ else  sequence
 *   │  │     ├─ check             the deterministic gate: checkride, a command, or none
 *   │  │     └─ critique          the read-only critic's verdict and feedback
 *   │  └─ record                  archive the iteration and rewrite the run summary
 *   └─ gate                       guard: stop on approval over a green check, the cost cap, or a gate edit
 *      finish                     { value: the final state, converged }
 */
import { branch, loop, sequence, step } from 'fascicle';
import type { Step } from 'fascicle';
import { cost_cap_hit } from './cost.js';
import { gate, initial_state, remaining_iterations } from './loop_state.js';
import {
  build_phase,
  check_phase,
  critique_phase,
  record_phase,
  skip_verify_phase,
} from './phases.js';
import type { PhaseDeps } from './phases.js';
import type { LoopState, RunInput } from './types.js';

/** What the flow resolves to: the final state, and whether the guard stopped the
 * loop (success, the cost cap, a gate edit) rather than the round budget. */
export type LoopOutcome = { value: LoopState; converged: boolean };

export function build_flow(
  deps: PhaseDeps,
  resume_from: LoopState | null,
): Step<RunInput, LoopOutcome> {
  const { config } = deps;

  // `build` and `critique` reach the model through `engine.generate` inside their
  // phase bodies rather than as `model_call` leaves: the renderer streams each
  // call's chunks live, and the critic's degradation ladder chooses which errors
  // to retry. Both become leaves once robmclarty/fascicle#7 lands.
  const build = step('build', (s: LoopState, ctx) => build_phase(deps, s, ctx));
  const skip_verify = step('skip_verify', (s: LoopState) => skip_verify_phase(deps, s));
  const check = step('check', (s: LoopState, ctx) => check_phase(deps, s, ctx));
  const critique = step('critique', (s: LoopState, ctx) => critique_phase(deps, s, ctx));
  const record = step('record', (s: LoopState) => record_phase(deps, s));

  const verify: Step<LoopState, LoopState> = branch({
    name: 'verify',
    when: (s: LoopState) => cost_cap_hit(config, s),
    // fascicle names this arm `then`. It holds a Step object, never a function,
    // so nothing can mistake the config for a thenable.
    // oxlint-disable-next-line unicorn/no-thenable
    then: skip_verify,
    otherwise: sequence([check, critique]),
  });

  const iteration: Step<LoopState, LoopState> = sequence([build, verify, record], {
    name: 'iteration',
  });

  return loop<RunInput, LoopState, LoopOutcome>({
    name: 'volley',
    init: (input) => input.resume_from ?? initial_state(),
    body: iteration,
    guard: step('gate', (s: LoopState) => gate(config, s)),
    finish: (s, { converged }) => ({ value: s, converged }),
    max_rounds: remaining_iterations(config, resume_from),
  });
}
