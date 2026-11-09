/**
 * The tester seat: one session before the first build that writes a failing
 * test from the criteria under the test and fixture gate paths (move 1's D5,
 * D20). It takes the critic's provider, URL and effort, and the critic's model
 * unless `--tester-model` names one (D7, D15), since writing the right test is
 * reading work and the critic seat is on every run.
 *
 * Confinement is per provider, as the critic's is. A `claude_cli` tester runs
 * under its own permission list (`tester_allowed_tools`,
 * `TESTER_DISALLOWED_TOOLS`) in the CLI's default mode; every other tester gets
 * volley's `tester_tools`, with no shell. This module builds the call and the
 * dry run's probe of it; the flow runs it.
 */
import { model_call } from 'fascicle';
import type {
  Engine,
  GenerateOptions,
  GenerateResult,
  RunContext,
  Step,
  StreamChunk,
  Tool,
} from 'fascicle';
import {
  settings_args,
  tester_allowed_tools,
  TESTER_DISALLOWED_TOOLS,
} from '../claude_cli_permissions.js';
import { ignores_effort } from '../config.js';
import { accumulate } from '../cost.js';
import { seat_base_url } from '../engine.js';
import { prewarm_ollama_model } from '../prewarm.js';
import { phase_error } from '../types.js';
import type { LoopState, ResolvedConfig } from '../types.js';
import { read_only_tools, workspace_inventory } from '../workspace_tools.js';
import { build_root } from '../worktree.js';
import { compose_tester_prompt, resolve_tester_prompt } from './prompt.js';
import { tester_tools, writable_gate_patterns } from './tools.js';

/** The tester's step budget on a tool-loop provider: reading the workspace,
 * then a test file or two. Its own constant, so a change to the builder's or
 * fascicle's default can't move it. */
const TESTER_MAX_STEPS = 30;

/** One write a turn, as a local builder makes by default: some model and
 * runtime pairs return parallel calls badly. Reads don't count. */
const TESTER_MAX_TOOL_CALLS = 1;

/** The model the tester runs: `--tester-model`, else the critic's. */
export function tester_model(config: ResolvedConfig): string {
  return config.tester_model ?? config.critic_model;
}

export type TesterDeps = {
  engine: Engine;
  config: ResolvedConfig;
  on_chunk: (chunk: StreamChunk) => void;
  /** Tools in place of `tester_tools`, as the critic takes them. A
   * `claude_cli` tester uses the CLI's own and never takes these. */
  tools?: ReadonlyArray<Tool>;
};

/** The tester's tool wiring for its provider. */
function tester_tool_options(
  config: ResolvedConfig,
  tools?: ReadonlyArray<Tool>,
): Pick<
  GenerateOptions,
  'tools' | 'provider_options' | 'max_steps' | 'tool_error_policy' | 'max_tool_calls_per_step'
> {
  if (config.critic_provider === 'claude_cli') {
    return {
      provider_options: {
        claude_cli: {
          allowed_tools: tester_allowed_tools(writable_gate_patterns(config.gate_paths)),
          extra_args: ['--disallowedTools', TESTER_DISALLOWED_TOOLS, ...settings_args()],
        },
      },
    };
  }
  return {
    tools:
      tools === undefined
        ? tester_tools(build_root(config.workspace, config.worktree), config.gate_paths)
        : [...tools],
    max_steps: TESTER_MAX_STEPS,
    // A refused write is the tester's to read and route around, not the run's
    // end.
    tool_error_policy: 'feed_back',
    max_tool_calls_per_step: TESTER_MAX_TOOL_CALLS,
  };
}

/** The tester's model boundary: one session, its output the whole result,
 * from which the phase records its usage, cost and timing. */
export type TesterStep = Step<string, GenerateResult<string>>;

/** The tester's one call: its system prompt, its tools, the critic's effort. */
export function make_tester_step(deps: TesterDeps): TesterStep {
  const { config } = deps;
  return model_call({
    engine: deps.engine,
    id: 'tester',
    description: 'model call writing a failing test under the test and fixture gate paths',
    provider: config.critic_provider,
    model: tester_model(config),
    system: resolve_tester_prompt(config.critic_provider),
    on_chunk: deps.on_chunk,
    ...(config.critic_effort !== null ? { effort: config.critic_effort } : {}),
    ...tester_tool_options(config, deps.tools),
  });
}

/** The prompt of the tester's call, from the run's criteria, writable
 * patterns, check, and the build root as it stands. */
export function tester_prompt(config: ResolvedConfig): string {
  return compose_tester_prompt({
    criteria: config.criteria,
    writable: writable_gate_patterns(config.gate_paths),
    check: config.check,
    inventory: workspace_inventory(build_root(config.workspace, config.worktree)),
  });
}

/** Run the tester's session on the iteration `state` opened, folding its
 * record and spend into the state as `tester` (D21). A failure is a phase
 * error of its own, which exits as a provider error does. */
export async function run_tester(
  tester: TesterStep,
  config: ResolvedConfig,
  state: LoopState,
  ctx: RunContext,
): Promise<LoopState> {
  try {
    // The cold-load guard every Ollama seat takes, on the critic's server.
    if (config.critic_provider === 'ollama') {
      await prewarm_ollama_model(
        seat_base_url('ollama', config.critic_url, process.env),
        tester_model(config),
        ctx.abort,
      );
    }
    const result = await ctx.call(tester, tester_prompt(config));
    const tested = accumulate(state, 'tester', result, tester_model(config));
    // An effort its provider drops (ollama, lmstudio) is said on the record.
    if (config.critic_effort === null || !ignores_effort(config.critic_provider)) return tested;
    return tested.tester === null
      ? tested
      : { ...tested, tester: { ...tested.tester, effort_ignored: true } };
  } catch (err) {
    throw phase_error('tester', state.iteration, err);
  }
}

/** What the dry run learned about a local tester seat. */
export type TesterCanary = { outcome: 'ok' } | { outcome: 'failed'; detail: string };

const TESTER_CANARY_PROMPT = [
  'CANARY CHECK: a tiny wiring probe, not a real task. Write nothing.',
  'Call the read_file tool on the path "package.json", then, whatever it',
  'returns, reply with the one word "canary".',
].join('\n');

/**
 * The `--dry-run` probe of a local tester: one $0 call with the tester's model
 * and system prompt that must make a tool call, as the critic's canary does,
 * since a tool-call death is how a local seat fails. It holds the read tools
 * only, so a dry run never writes; preflight runs it for an `ollama` or
 * `lmstudio` tester, whose calls cost nothing.
 */
export async function tester_canary(
  engine: Engine,
  config: ResolvedConfig,
  env: Record<string, string | undefined> = process.env,
): Promise<TesterCanary> {
  if (config.critic_provider === 'ollama') {
    await prewarm_ollama_model(seat_base_url('ollama', config.critic_url, env), tester_model(config));
  }
  try {
    await engine.generate({
      provider: config.critic_provider,
      model: tester_model(config),
      system: resolve_tester_prompt(config.critic_provider),
      prompt: TESTER_CANARY_PROMPT,
      tools: read_only_tools(build_root(config.workspace, config.worktree)),
      max_steps: 3,
      tool_error_policy: 'feed_back',
    });
    return { outcome: 'ok' };
  } catch (err) {
    return { outcome: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
}
