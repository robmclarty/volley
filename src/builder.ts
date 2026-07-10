/**
 * Builder invocation (spec §6): one `engine.generate` call per iteration is
 * one complete agentic Claude Code session in the workspace.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Engine, GenerateOptions, StreamChunk } from 'fascicle';
import type { RunContext } from 'fascicle';
import { builder_tools } from './builder/tools.js';
import { accumulate } from './cost.js';
import { config_error, phase_error } from './types.js';
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

/** Walk up from this module to the package root (works from src/ under tsx
 * and from dist/ in the published package, which ships src/builder/presets). */
export function presets_dir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'src', 'builder', 'presets');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw config_error('builder presets directory not found');
}

// D12: the CLI system prompt assumes CLI semantics (built-in tools, implicit
// cwd), so the local builder gets its own — the volley tool set, the
// workspace-is-cwd convention, and the harness-enforced `finish` stop.
export function compose_builder_system_local(): string {
  const identity = [
    'You are the builder inside the volley harness: an autonomous agent',
    'iterating on a workspace until it satisfies a task and its acceptance',
    'criteria.',
  ].join('\n');
  const append = readFileSync(join(presets_dir(), 'harness_append_local.md'), 'utf8');
  return `${identity}\n\n${append.trimEnd()}`;
}

/** The builder system prompt for the active provider (D12): the `claude_cli`
 * prompt (implicit built-in tools, "the current working directory") for the
 * CLI builder, or the local prompt (volley's tool set, workspace-is-cwd, and
 * the harness-enforced `finish` stop) for a local model. Mirrors the critic's
 * `resolve_critic_prompt`. */
function resolve_builder_system(config: ResolvedConfig): string {
  return config.builder_provider === 'claude_cli'
    ? compose_builder_system()
    : compose_builder_system_local();
}

// Salvage budget for a tool call a local model emits as assistant text instead
// of a structured tool_call (Hermes / json-fenced / Qwen3-Coder XML). Must be
// > 0 to turn salvage on (D5/C5); the budget is shared across the whole
// generate call and each salvage is observable on the result for step 8's
// health metric.
export const BUILDER_TOOL_CALL_REPAIR_ATTEMPTS = 3;

/** Per-provider tool wiring for the builder, mirroring `critic_tool_options`.
 * The `claude_cli` builder is confined at the CLI permission layer (allowlist +
 * permission mode) and brings its own built-in tools — this arm is unchanged
 * from v2 (C3). A local builder brings none, so volley supplies its whole
 * workspace tool surface plus the five per-call loop knobs (D5/C5) and **no**
 * schema (it produces a workspace, not a verdict); per-call values win over
 * engine defaults. */
function builder_tool_options(
  config: ResolvedConfig,
): Pick<
  GenerateOptions,
  | 'tools'
  | 'provider_options'
  | 'max_steps'
  | 'tool_error_policy'
  | 'tool_call_repair_attempts'
  | 'max_tool_calls_per_step'
> {
  if (config.builder_provider === 'claude_cli') {
    return {
      provider_options: {
        claude_cli: {
          allowed_tools: [...BUILDER_ALLOWED_TOOLS],
          extra_args: ['--permission-mode', config.builder_permission_mode],
        },
      },
    };
  }
  return {
    tools: builder_tools(config.workspace),
    max_steps: config.builder_max_steps,
    tool_error_policy: 'feed_back',
    tool_call_repair_attempts: BUILDER_TOOL_CALL_REPAIR_ATTEMPTS,
    max_tool_calls_per_step: 1,
  };
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
      provider: config.builder_provider,
      model: config.builder_model,
      system: resolve_builder_system(config),
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
      ...builder_tool_options(config),
    });
    return accumulate(state, 'builder', result, config.builder_model);
  } catch (err) {
    throw phase_error('builder', state.iteration, err);
  }
}
