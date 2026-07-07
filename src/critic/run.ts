/**
 * Critic invocation (spec §6): a read-only `claude_cli` session returning a
 * schema-validated structured verdict. The harness — not the critic — writes
 * `.volley/feedback.md` and `.volley/verdict`.
 */
import { z } from 'zod';
import type { Engine, StreamChunk } from 'fascicle';
import type { RunContext } from 'fascicle';
import { accumulate } from '../cost.js';
import { phase_error } from '../types.js';
import type { LoopState, ResolvedConfig } from '../types.js';
import { compose_critic_prompt, resolve_critic_prompt } from './prompt.js';

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
    const result = await engine.generate({
      provider: 'claude_cli',
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
      provider_options: {
        claude_cli: {
          allowed_tools: [...CRITIC_ALLOWED_TOOLS],
          extra_args: ['--disallowedTools', CRITIC_DISALLOWED_TOOLS],
        },
      },
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
