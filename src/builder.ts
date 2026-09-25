/**
 * Builder invocation: one `engine.generate` call per iteration is
 * one complete agentic Claude Code session in the workspace.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Engine, GenerateOptions, StreamChunk } from 'fascicle';
import type { RunContext } from 'fascicle';
import { warn_small_local_context } from './builder/context_check.js';
import { builder_tools, type BashExecutor } from './builder/tools.js';
import { accumulate } from './cost.js';
import { resolve_ollama_base_url } from './engine.js';
import { prewarm_ollama_model } from './prewarm.js';
import { config_error, phase_error } from './types.js';
import type { LoopState, ResolvedConfig } from './types.js';
import { build_root } from './worktree.js';

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

// The CLI system prompt assumes CLI semantics (built-in tools, implicit
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

/** The builder system prompt for the active provider: the `claude_cli`
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
// > 0 to turn salvage on; the budget is shared across the whole
// generate call and each salvage is observable on the result for the
// salvage-rate health metric.
const BUILDER_TOOL_CALL_REPAIR_ATTEMPTS = 3;

/** Per-provider tool wiring for the builder, mirroring `critic_tool_options`.
 * The `claude_cli` builder is confined at the CLI permission layer (allowlist +
 * permission mode) and brings its own built-in tools — this arm is unchanged
 * from v2. A local builder brings none, so volley supplies its whole
 * workspace tool surface plus the five per-call loop knobs and **no**
 * schema (it produces a workspace, not a verdict); per-call values win over
 * engine defaults. */
function builder_tool_options(
  config: ResolvedConfig,
  bash_executor: BashExecutor | null,
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
    // Containment root re-points to the worktree under `--worktree`, so
    // the model's writes, edits, and `bash` cwd land there and leave the
    // workspace untouched. When the sandbox is active its `docker exec` executor
    // runs `bash` in the container against the bind-mounted worktree; the
    // host `spawnSync` default stands in otherwise.
    tools: builder_tools(
      build_root(config.workspace, config.worktree),
      bash_executor !== null ? { bash_executor } : {},
    ),
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

// A `max_steps` cutoff is not an error. The local builder burned its whole
// step budget without calling `finish`, so its partial workspace goes to check
// + critic exactly like a `finish`-terminated iteration (the critic sees
// incomplete work and requests changes, the loop continues). The renderer
// surfaces this as a warning and `finish_reason: 'max_steps'` is recorded in
// the iteration summary — non-convergence is data, not an exception.
function builder_max_steps_warning(max_steps: number): string {
  return (
    `builder hit the ${String(max_steps)}-step limit without calling finish; ` +
    'handing the partial workspace to check + critic (raise --builder-max-steps if this recurs)'
  );
}

export type BuilderDeps = {
  engine: Engine;
  config: ResolvedConfig;
  on_chunk: (chunk: StreamChunk) => void;
  warn: (message: string) => void;
  /** The `bash` executor for a sandboxed local builder (`docker exec` against
   * the run's container), or null to use the host `spawnSync` default (the
   * unsandboxed escape hatch, or `claude_cli` which supplies no volley tools). */
  bash_executor?: BashExecutor | null;
};

export async function run_builder(
  deps: BuilderDeps,
  state: LoopState,
  ctx: RunContext,
): Promise<LoopState> {
  const { engine, config } = deps;
  try {
    // Warn at builder start where a too-small context window is detectable —
    // it silently truncates tool schemas (the #1 local tool-calling failure) —
    // then pre-load the model so a cold multi-GB load doesn't blow the real
    // call's first-byte timeout. Both best-effort and Ollama-only; neither
    // blocks the build.
    if (config.builder_provider === 'ollama') {
      const base_url = resolve_ollama_base_url(process.env);
      await warn_small_local_context(
        config.builder_provider,
        config.builder_model,
        base_url,
        deps.warn,
        ctx.abort,
      );
      await prewarm_ollama_model(base_url, config.builder_model, ctx.abort);
    }
    // Timed after the prewarm: a cold model load is setup, not the phase's work.
    const started = Date.now();
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
      ...builder_tool_options(config, deps.bash_executor ?? null),
    });
    // `max_steps` is a backstop, not a failure — surface it and carry on.
    if (result.finish_reason === 'max_steps') {
      deps.warn(builder_max_steps_warning(config.builder_max_steps));
    }
    return accumulate(state, 'builder', result, config.builder_model, Date.now() - started);
  } catch (err) {
    throw phase_error('builder', state.iteration, err);
  }
}
