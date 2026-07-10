/**
 * Critic invocation (spec §6): a read-only `claude_cli` session returning a
 * schema-validated structured verdict. The harness — not the critic — writes
 * `.volley/feedback.md` and `.volley/verdict`.
 */
import { z } from 'zod';
import type { Engine, GenerateOptions, StreamChunk } from 'fascicle';
import type { RunContext } from 'fascicle';
import { accumulate } from '../cost.js';
import { resolve_ollama_base_url } from '../engine.js';
import { prewarm_ollama_model } from '../prewarm.js';
import { phase_error } from '../types.js';
import type { LoopState, ResolvedConfig } from '../types.js';
import { compose_critic_prompt, resolve_critic_prompt } from './prompt.js';
import { read_only_tools } from './tools.js';

export const CRITIC_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob'] as const;

export const CRITIC_DISALLOWED_TOOLS = 'Write,Edit,MultiEdit,NotebookEdit,Bash';

export const verdict_schema = z.object({
  verdict: z.enum(['approved', 'changes_requested']),
  feedback: z
    .string()
    .describe(
      'Free-form markdown for the builder. Concrete and actionable. ' +
        'Will be passed verbatim into the next iteration.',
    ),
  unmet_criteria: z
    .array(z.string())
    .describe(
      'The specific acceptance criteria judged unmet, verbatim. Empty when approved.',
    ),
});

export type VerdictOutput = z.infer<typeof verdict_schema>;

export type CriticDeps = {
  engine: Engine;
  config: ResolvedConfig;
  on_chunk: (chunk: StreamChunk) => void;
};

/** Read-only tool wiring per provider. The claude_cli critic is confined at
 * the CLI permission layer (allowlist + explicit disallow); a local-model
 * critic gets volley's own workspace-scoped read-only tools and no write
 * path at all. */
function critic_tool_options(
  config: ResolvedConfig,
): Pick<GenerateOptions<VerdictOutput>, 'tools' | 'provider_options'> {
  if (config.critic_provider === 'claude_cli') {
    return {
      provider_options: {
        claude_cli: {
          allowed_tools: [...CRITIC_ALLOWED_TOOLS],
          extra_args: ['--disallowedTools', CRITIC_DISALLOWED_TOOLS],
        },
      },
    };
  }
  return { tools: read_only_tools(config.workspace) };
}

export async function run_critic(
  deps: CriticDeps,
  state: LoopState,
  ctx: RunContext,
): Promise<LoopState> {
  const { engine, config } = deps;
  if (state.check === null) {
    throw phase_error('critic', state.iteration, new Error('check phase did not run'));
  }
  try {
    // Same cold-load guard as the builder: pre-load an Ollama critic model so
    // a cold multi-GB load doesn't blow the real call's first-byte timeout.
    // Best-effort; a model the builder already warmed returns immediately.
    if (config.critic_provider === 'ollama') {
      await prewarm_ollama_model(
        resolve_ollama_base_url(process.env),
        config.critic_model,
        ctx.abort,
      );
    }
    const result = await engine.generate({
      provider: config.critic_provider,
      model: config.critic_model,
      system: resolve_critic_prompt(config),
      prompt: compose_critic_prompt({
        criteria: config.criteria,
        iteration: state.iteration,
        check: state.check,
      }),
      schema: verdict_schema,
      abort: ctx.abort,
      trajectory: ctx.trajectory,
      on_chunk: deps.on_chunk,
      ...critic_tool_options(config),
    });
    return {
      ...accumulate(state, 'critic', result, config.critic_model),
      verdict: result.content.verdict,
      feedback: result.content.feedback,
      unmet_criteria: result.content.unmet_criteria,
    };
  } catch (err) {
    throw phase_error('critic', state.iteration, err);
  }
}
