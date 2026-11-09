/**
 * The volley flow: the whole topology of one run, and nothing else. Step bodies
 * live in `./phases.ts`, the model boundaries in `./builder.ts` and
 * `./critic/run.ts`, the stopping rule in `./loop_state.ts`, and the shell
 * around the flow (workspace setup, the worktree lifecycle, `run`, the final
 * summary) in `./orchestrator.ts`.
 *
 * With `--tester on`, the run's first iteration opens with the test phase: the
 * tester writes a failing test, then the check must fail on it. A green check
 * there, or a tester that crossed the cost cap, holds the iteration with no
 * build, and the guard ends the run. Every other iteration, and every run with
 * the tester off, passes through `test` and `work` to today's build and verify.
 *
 * A critique (`build_critique_flow`) is one round over a change already made,
 * so it has no builder, no loop, and no guard: `measure`, which opens the
 * round and measures the change from its baseline, then the same `check`,
 * `critique`, and `record` a run's round ends with.
 *
 * fascicle's `describe.diagram` draws the tree below from the flow itself, and
 * `test/unit/flow_diagram.test.ts` holds it to the code: change a row by changing
 * its step's `description`, then paste `pnpm diagram --prefix ' *   '` over it.
 *
 *   volley                                      loop: one round per iteration, up to max_iterations
 *   ├─ iteration                                sequence
 *   │  ├─ test                                  branch: does the tester open this iteration? (--tester on, the run's first)
 *   │  │  ├─ then  sequence
 *   │  │  │  ├─ write_test                      open the iteration, run the tester, record what it wrote
 *   │  │  │  │  └─ tester                       model call writing a failing test under the test and fixture gate paths
 *   │  │  │  └─ red                             branch: did the tester alone cross the cost cap?
 *   │  │  │     ├─ then  skip_red               record the check as skipped and build nothing
 *   │  │  │     └─ else  red_check              the check, which must fail on the tester's test
 *   │  │  └─ else  no_test                      no tester this iteration
 *   │  ├─ work                                  branch: did the test phase end the run: a green check, or the cost cap?
 *   │  │  ├─ then  hold                         build nothing, and leave the run to the guard
 *   │  │  └─ else  sequence
 *   │  │     ├─ build                           open the iteration unless the tester did, run the builder, measure the change
 *   │  │     │  └─ builder                      model call: one agentic session in the build root
 *   │  │     └─ verify                          branch: did the build alone cross the cost cap?
 *   │  │        ├─ then  skip_verify            record the check as skipped and call no critic
 *   │  │        └─ else  sequence
 *   │  │           ├─ check                     the deterministic gate: checkride, a command, or none
 *   │  │           └─ critique                  the read-only critic's verdict and feedback
 *   │  │              └─ critic                 fallback: judge without tools if a critic on any provider but claude_cli keeps dying or runs out of steps
 *   │  │                 ├─ retry               one more try after a stream death, on any provider but claude_cli
 *   │  │                 │  └─ critic_tools     model call with read-only workspace tools
 *   │  │                 └─ pipe                mark the verdict degraded
 *   │  │                    └─ critic_toolless  model call judging from the check output and a file list
 *   │  └─ record                                archive the iteration and rewrite the run summary
 *   └─ guard  gate                              stop on approval over a green check, the cost cap, a gate edit, or a green check before any build
 */
import { branch, fallback, loop, pipe, retry, sequence, step } from 'fascicle';
import type { Step } from 'fascicle';
import { make_builder_ladder } from './builder.js';
import type { BuilderDeps } from './builder.js';
import type { BashExecutor } from './builder/tools.js';
import { cost_cap_hit } from './cost.js';
import {
  as_degraded,
  critic_degradable,
  critic_retryable,
  make_critic_toolless_step,
  make_critic_tools_step,
  MAX_CRITIC_RETRIES,
  toolless_critic_prompt,
  with_fallback_cause,
  with_retries,
} from './critic/run.js';
import type { CriticDeps, CriticStep } from './critic/run.js';
import {
  gate,
  initial_state,
  remaining_iterations,
  tester_opened,
  tester_opens,
  tester_passed_early,
} from './loop_state.js';
import {
  build_phase,
  check_phase,
  critique_phase,
  measure_phase,
  record_phase,
  red_check_phase,
  skip_red_phase,
  skip_verify_phase,
  test_phase,
} from './phases.js';
import type { PhaseDeps } from './phases.js';
import { make_tester_step } from './tester/run.js';
import type { TesterDeps } from './tester/run.js';
import type { LoopState, ResolvedConfig, RunInput } from './types.js';

/** The builder seat: the engine its calls go through, and, when the caller
 * injects them, the tools that replace volley's own set, the name of that set
 * (which its prompt names), and the handler that answers their approval
 * requests. */
export type BuilderSeat = Pick<BuilderDeps, 'engine' | 'tools' | 'tool_set' | 'on_tool_approval'>;

/** The critic seat: its engine and, when injected, the tools that replace its
 * reads and the name of their set. It takes no approval handler, since its
 * reads never ask. */
export type CriticSeat = Pick<CriticDeps, 'engine' | 'tools' | 'tool_set'>;

/** The tester seat: its engine and, when injected, the tools that replace
 * volley's tester tools, the name of their set, and the handler that answers
 * their approval requests. Absent, it rides the critic's engine, whose
 * provider and URL it takes. */
export type TesterSeat = Pick<TesterDeps, 'engine' | 'tools' | 'tool_set' | 'on_tool_approval'>;

/** What the flow is built from: the step bodies' dependencies, plus each
 * seat's model wiring and the builder's `bash` executor. The two seats share
 * one engine unless they reach one provider at different URLs. */
export type FlowDeps = PhaseDeps & {
  seats: { builder: BuilderSeat; critic: CriticSeat; tester?: TesterSeat };
  /** The local builder's `bash` executor, or null for the host `spawnSync`
   * default (and for `claude_cli`, which supplies no volley tools). */
  bash_executor: BashExecutor | null;
};

/** What the flow resolves to: the final state, and whether the guard stopped the
 * loop (success, the cost cap, a gate edit) rather than the round budget. */
export type LoopOutcome = { value: LoopState; converged: boolean };

/** The critic arm: the degradation ladder. A critic on any provider but
 * `claude_cli` whose tool-bearing stream dies is retried at once (the death is
 * stochastic parser failure, not load, so waiting buys nothing), then judged
 * once without tools. One that runs out of steps skips the retry, since
 * another identical tool loop would only run out again, and goes straight to
 * the tool-less pass. Anything else propagates from either rung untouched. */
export function build_critic(deps: CriticDeps): CriticStep {
  const retryable = critic_retryable(deps.config);
  return fallback(
    retry(make_critic_tools_step(deps), {
      description: 'one more try after a stream death, on any provider but claude_cli',
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
      description: 'judge without tools if a critic on any provider but claude_cli keeps dying or runs out of steps',
      when: critic_degradable(deps.config),
      handoff: (prompt) => toolless_critic_prompt(deps.config, prompt),
      project: with_fallback_cause,
    },
  );
}

/** The steps a run and a critique share, built one way for both. */
function check_step(deps: PhaseDeps): Step<LoopState, LoopState> {
  return step('check', (s: LoopState, ctx) => check_phase(deps, s, ctx), {
    description: 'the deterministic gate: checkride, a command, or none',
  });
}

function critique_step(deps: PhaseDeps, seat: CriticSeat): Step<LoopState, LoopState> {
  const critic = build_critic({ ...seat, config: deps.config, on_chunk: deps.renderer.critic_chunk });
  return step('critique', (s: LoopState, ctx) => critique_phase(deps, critic, s, ctx), {
    description: "the read-only critic's verdict and feedback",
    arm: critic,
  });
}

function record_step(deps: PhaseDeps): Step<LoopState, LoopState> {
  return step('record', (s: LoopState) => record_phase(deps, s), {
    description: 'archive the iteration and rewrite the run summary',
  });
}

/** The test phase (move 1's D6, D17, D21): with the tester on, the run's
 * first iteration opens with the tester writing a failing test, then the
 * check, which must fail on it, unless the tester alone crossed the cost cap.
 * Every other iteration passes straight through. */
function test_step(deps: FlowDeps): Step<LoopState, LoopState> {
  const { config } = deps;
  const tester = make_tester_step({
    ...(deps.seats.tester ?? { engine: deps.seats.critic.engine }),
    config,
    on_chunk: deps.renderer.tester_chunk,
  });
  const write_test = step('write_test', (s: LoopState, ctx) => test_phase(deps, tester, s, ctx), {
    description: 'open the iteration, run the tester, record what it wrote',
    arm: tester,
  });
  const red: Step<LoopState, LoopState> = branch({
    name: 'red',
    description: 'did the tester alone cross the cost cap?',
    when: (s: LoopState) => cost_cap_hit(config, s),
    // oxlint-disable-next-line unicorn/no-thenable
    then: step('skip_red', (s: LoopState) => skip_red_phase(deps, s), {
      description: 'record the check as skipped and build nothing',
    }),
    otherwise: step('red_check', (s: LoopState, ctx) => red_check_phase(deps, s, ctx), {
      description: "the check, which must fail on the tester's test",
    }),
  });
  return branch({
    name: 'test',
    description: "does the tester open this iteration? (--tester on, the run's first)",
    when: (s: LoopState) => tester_opens(config, s),
    // oxlint-disable-next-line unicorn/no-thenable
    then: sequence([write_test, red]),
    otherwise: step('no_test', (s: LoopState) => s, { description: 'no tester this iteration' }),
  });
}

/** Whether the test phase ended the run before its build: the check passed on
 * the tester's test, or the tester crossed the cost cap. */
function test_ended_run(config: ResolvedConfig, s: LoopState): boolean {
  return tester_opened(s) && (tester_passed_early(s) || cost_cap_hit(config, s));
}

export function build_flow(
  deps: FlowDeps,
  resume_from: LoopState | null,
): Step<RunInput, LoopOutcome> {
  const { config, renderer } = deps;

  const builders = make_builder_ladder({
    ...deps.seats.builder,
    config,
    on_chunk: renderer.builder_chunk,
    bash_executor: deps.bash_executor,
  });

  // `build` and `critique` hand their model boundary to `ctx.call` from inside
  // the body, because the prompt comes from the carried state and the result
  // folds back into it. Each declares that boundary as its `arm`, so it shows
  // up under the step in `describe` and the trajectory's flow structure. The
  // build picks its leaf by the build's rung; the arm is the first build's.
  const build = step('build', (s: LoopState, ctx) => build_phase(deps, builders, s, ctx), {
    description: 'open the iteration unless the tester did, run the builder, measure the change',
    arm: builders.arm,
  });
  const skip_verify = step('skip_verify', (s: LoopState) => skip_verify_phase(deps, s), {
    description: 'record the check as skipped and call no critic',
  });
  const check = check_step(deps);
  const critique = critique_step(deps, deps.seats.critic);
  const record = record_step(deps);

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

  const work: Step<LoopState, LoopState> = branch({
    name: 'work',
    description: 'did the test phase end the run: a green check, or the cost cap?',
    when: (s: LoopState) => test_ended_run(config, s),
    // oxlint-disable-next-line unicorn/no-thenable
    then: step('hold', (s: LoopState) => s, {
      description: 'build nothing, and leave the run to the guard',
    }),
    otherwise: sequence([build, verify]),
  });

  const iteration: Step<LoopState, LoopState> = sequence([test_step(deps), work, record], {
    name: 'iteration',
  });

  return loop<RunInput, LoopState, LoopOutcome>({
    name: 'volley',
    description: 'one round per iteration, up to max_iterations',
    init: (input) => input.resume_from ?? initial_state(),
    body: iteration,
    guard: step('gate', (s: LoopState) => gate(config, s), {
      description: "stop on approval over a green check, the cost cap, a gate edit, or a green check before any build",
    }),
    finish: (s, { converged }) => ({ value: s, converged }),
    max_rounds: remaining_iterations(config, resume_from),
  });
}

/** What a critique's flow is built from: the step bodies' dependencies and the
 * critic seat. There's no builder seat, so no builder is ever constructed. */
export type CritiqueFlowDeps = PhaseDeps & { critic: CriticSeat };

/** A critique: one round over a change already made. `measure` opens it and
 * measures the change from the baseline, then the check, the critic, and the
 * record, as in a run's round. No loop and no guard: there is nothing to
 * iterate on, and the caller reads the outcome off the final state. */
export function build_critique_flow(deps: CritiqueFlowDeps): Step<LoopState, LoopState> {
  const measure = step('measure', (s: LoopState, ctx) => measure_phase(deps, s, ctx), {
    description: 'open the round and measure the change under review',
  });
  return sequence([measure, check_step(deps), critique_step(deps, deps.critic), record_step(deps)], {
    name: 'critique_run',
  });
}
