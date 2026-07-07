/**
 * Builder invocation (spec §6): one `engine.generate` call per iteration is
 * one complete agentic Claude Code session in the workspace.
 */
import type { Engine, StreamChunk } from 'fascicle';
import type { RunContext } from 'fascicle';
import { accumulate } from './cost.js';
import { phase_error } from './types.js';
import type { LoopState, ResolvedConfig } from './types.js';

export const BUILDER_ALLOWED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Bash',
  'Grep',
  'Glob',
  'WebFetch',
] as const;

export function compose_builder_system(): string {
  return [
    'You are the builder inside the volley harness: an autonomous agent',
    'iterating on a workspace until it satisfies a task and its acceptance',
    'criteria. Work directly in the current working directory. Plan',
    'internally, make the changes, and verify your own work before finishing.',
  ].join('\n');
}

export type BuilderPromptInput = {
  task: string;
  criteria: string;
  feedback: string | null;
  iteration: number;
  checkride: boolean;
};

export function compose_builder_prompt(input: BuilderPromptInput): string {
  const parts = [
    'TASK',
    '----',
    input.task,
    '',
    'ACCEPTANCE CRITERIA',
    '-------------------',
    input.criteria,
    '',
    `ITERATION: ${input.iteration}`,
  ];
  if (input.iteration > 1 && input.feedback !== null) {
    parts.push(
      '',
      'PREVIOUS CRITIC FEEDBACK',
      '------------------------',
      input.feedback,
      '',
      'Address the feedback above. The workspace already contains your prior work;',
      'read the current state, then make the necessary changes.',
    );
  }
  if (input.checkride) {
    parts.push(
      '',
      'The definition of done for this workspace includes `pnpm check` (checkride)',
      'exiting 0. Run it yourself before finishing; on failure, read',
      '.check/summary.json, then the failing slot\'s raw output, fix, and re-run.',
    );
  }
  return parts.join('\n');
}

export type BuilderDeps = {
  engine: Engine;
  config: ResolvedConfig;
  on_chunk: (chunk: StreamChunk) => void;
};

export async function run_builder(
  deps: BuilderDeps,
  state: LoopState,
  ctx: RunContext,
): Promise<LoopState> {
  const { engine, config } = deps;
  try {
    const result = await engine.generate({
      provider: 'claude_cli',
      model: config.builder_model,
      system: compose_builder_system(),
      prompt: compose_builder_prompt({
        task: config.prompt,
        criteria: config.criteria,
        feedback: state.feedback,
        iteration: state.iteration,
        checkride: config.check_resolved === 'checkride',
      }),
      abort: ctx.abort,
      trajectory: ctx.trajectory,
      on_chunk: deps.on_chunk,
      provider_options: {
        claude_cli: {
          allowed_tools: [...BUILDER_ALLOWED_TOOLS],
          extra_args: ['--permission-mode', config.builder_permission_mode],
        },
      },
    });
    return accumulate(state, 'builder', result, config.builder_model);
  } catch (err) {
    throw phase_error('builder', state.iteration, err);
  }
}
