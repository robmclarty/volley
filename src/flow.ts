/**
 * The volley flow: the whole topology of one run, and nothing else. Step bodies
 * live in `./phases.ts`, the model boundaries in `./builder.ts` and
 * `./critic/run.ts`, the stopping rule in `./loop_state.ts`, and the shell
 * around the flow (workspace setup, the worktree lifecycle, `run`, the final
 * summary) in `./orchestrator.ts`.
 *
 * fascicle's `describe.diagram` draws the tree below from the flow itself, and
 * `test/unit/flow_diagram.test.ts` holds it to the code: change a row by changing
 * its step's `description`, then paste `pnpm diagram --prefix ' *   '` over it.
 *
 *   volley                                loop: one round per iteration, up to max_iterations
 *   ├─ iteration                          sequence
 *   │  ├─ build                           open the iteration, run the builder, measure the change
 *   │  │  └─ builder                      model call: one agentic session in the build root
 *   │  ├─ verify                          branch: did the build alone cross the cost cap?
 *   │  │  ├─ then  skip_verify            record the check as skipped and call no critic
 *   │  │  └─ else  sequence
 *   │  │     ├─ check                     the deterministic gate: checkride, a command, or none
 *   │  │     └─ critique                  the read-only critic's verdict and feedback
 *   │  │        └─ critic                 fallback: judge without tools if a local critic's stream keeps dying
 *   │  │           ├─ retry               one more try after a stream death, local providers only
 *   │  │           │  └─ critic_tools     model call with read-only workspace tools
 *   │  │           └─ pipe                mark the verdict degraded
 *   │  │              └─ critic_toolless  model call judging from the check output and a file list
 *   │  └─ record                          archive the iteration and rewrite the run summary
 *   └─ guard  gate                        stop on approval over a green check, the cost cap, or a gate edit
 */
import { branch, fallback, loop, pipe, retry, sequence, step } from 'fascicle';
import type { Engine, Step } from 'fascicle';
import { make_builder_step } from './builder.js';
import type { BashExecutor } from './builder/tools.js';
import { cost_cap_hit } from './cost.js';
import {
  as_degraded,
  critic_retryable,
  make_critic_toolless_step,
  make_critic_tools_step,
  MAX_CRITIC_RETRIES,
  toolless_critic_prompt,
  with_fallback_cause,
  with_retries,
} from './critic/run.js';
import type { CriticDeps, CriticStep } from './critic/run.js';
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

/** What the flow is built from: the step bodies' dependencies, plus the engine
 * and `bash` executor its model boundaries are wired to. */
export type FlowDeps = PhaseDeps & {
  engine: Engine;
  /** The local builder's `bash` executor, or null for the host `spawnSync`
   * default (and for `claude_cli`, which supplies no volley tools). */
  bash_executor: BashExecutor | null;
};

/** What the flow resolves to: the final state, and whether the guard stopped the
 * loop (success, the cost cap, a gate edit) rather than the round budget. */
export type LoopOutcome = { value: LoopState; converged: boolean };

/** The critic arm: the degradation ladder. A local critic whose tool-bearing
 * stream dies is retried at once (the death is stochastic parser failure, not
 * load, so waiting buys nothing), then judged once without tools; anything the
 * ladder does not retry propagates from either rung untouched. */
export function build_critic(deps: CriticDeps): CriticStep {
  const retryable = critic_retryable(deps.config);
  return fallback(
    retry(make_critic_tools_step(deps), {
      description: 'one more try after a stream death, local providers only',
      max_attempts: MAX_CRITIC_RETRIES + 1,
      backoff_ms: 0,
      when: retryable,
      project: with_retries,
    }),
    pipe(make_critic_toolless_step(deps), as_degraded, {
      description: 'mark the verdict degraded',
    }),
    {
      name: 'critic',
      description: "judge without tools if a local critic's stream keeps dying",
      when: retryable,
      handoff: (prompt) => toolless_critic_prompt(deps.config, prompt),
      project: with_fallback_cause,
    },
  );
}

export function build_flow(
  deps: FlowDeps,
  resume_from: LoopState | null,
): Step<RunInput, LoopOutcome> {
  const { config, renderer } = deps;

  const builder = make_builder_step({
    engine: deps.engine,
    config,
    on_chunk: renderer.builder_chunk,
    bash_executor: deps.bash_executor,
  });
  const critic = build_critic({ engine: deps.engine, config, on_chunk: renderer.critic_chunk });

  // `build` and `critique` hand their model boundary to `ctx.call` from inside
  // the body, because the prompt comes from the carried state and the result
  // folds back into it. Each declares that boundary as its `arm`, so it shows
  // up under the step in `describe` and the trajectory's flow structure.
  const build = step('build', (s: LoopState, ctx) => build_phase(deps, builder, s, ctx), {
    description: 'open the iteration, run the builder, measure the change',
    arm: builder,
  });
  const skip_verify = step('skip_verify', (s: LoopState) => skip_verify_phase(deps, s), {
    description: 'record the check as skipped and call no critic',
  });
  const check = step('check', (s: LoopState, ctx) => check_phase(deps, s, ctx), {
    description: 'the deterministic gate: checkride, a command, or none',
  });
  const critique = step(
    'critique',
    (s: LoopState, ctx) => critique_phase(deps, critic, s, ctx),
    { description: "the read-only critic's verdict and feedback", arm: critic },
  );
  const record = step('record', (s: LoopState) => record_phase(deps, s), {
    description: 'archive the iteration and rewrite the run summary',
  });

  const verify: Step<LoopState, LoopState> = branch({
    name: 'verify',
    description: 'did the build alone cross the cost cap?',
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
    description: 'one round per iteration, up to max_iterations',
    init: (input) => input.resume_from ?? initial_state(),
    body: iteration,
    guard: step('gate', (s: LoopState) => gate(config, s), {
      description: 'stop on approval over a green check, the cost cap, or a gate edit',
    }),
    finish: (s, { converged }) => ({ value: s, converged }),
    max_rounds: remaining_iterations(config, resume_from),
  });
}
