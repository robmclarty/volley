/**
 * Builder invocation: one call to the builder leaf per iteration is one
 * complete agentic session in the workspace — Claude Code under `claude_cli`,
 * or a model driving volley's tools on any other provider, local or hosted.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { model_call } from 'fascicle';
import type {
  Engine,
  GenerateOptions,
  GenerateResult,
  ModelCallInput,
  RunContext,
  Step,
  StreamChunk,
  Tool,
  ToolApprovalHandler,
} from 'fascicle';
import { warn_small_local_context } from './builder/context_check.js';
import { step_countdown } from './builder/countdown.js';
import { builder_tools, type BashExecutor } from './builder/tools.js';
import { accumulate } from './cost.js';
import { seat_base_url } from './engine.js';
import { prewarm_ollama_model } from './prewarm.js';
import { config_error, phase_error } from './types.js';
import type { CheckResult, LoopState, ResolvedConfig } from './types.js';
import type { ToolSet } from './workspace_tools.js';
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
export function builder_presets_dir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'src', 'builder', 'presets');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw config_error('builder presets directory not found');
}

/** The harness append each tool set's builder reads: one naming volley's own
 * tools, or one naming fascicle's workspace tools under `volley acp` and
 * saying what a call the user refused means. */
const HARNESS_APPENDS: Record<ToolSet, string> = {
  volley: 'harness_append_local.md',
  acp: 'harness_append_acp.md',
};

/** Step 2 of "Work this way", as both harness appends word it for a builder
 * held to one tool call a turn. */
const ONE_CALL_A_TURN = '2. Call one tool at a time and read its result before deciding the next\n   call.';

/** Step 2 for a builder that may make several calls a turn: fascicle runs a
 * turn's calls in order, so a read can't race an edit, but each change or
 * command is still worth reading before the next. */
function batched_calls(max_tool_calls: number): string {
  return [
    `2. Batch independent reads into one turn, up to ${String(max_tool_calls)} calls, but`,
    '   make one change or command per turn, and read its result before',
    '   deciding the next call.',
  ].join('\n');
}

// The CLI system prompt assumes CLI semantics (built-in tools, implicit
// cwd), so the local builder gets its own — its tool set, the
// workspace-is-cwd convention, and the harness-enforced `finish` stop.
export function compose_builder_system_local(
  tool_set: ToolSet = 'volley',
  max_tool_calls = 1,
): string {
  const identity = [
    'You are the builder inside the volley harness: an autonomous agent',
    'iterating on a workspace until it satisfies a task and its acceptance',
    'criteria.',
  ].join('\n');
  const append = readFileSync(join(builder_presets_dir(), HARNESS_APPENDS[tool_set]), 'utf8');
  const worded =
    max_tool_calls > 1 ? append.replace(ONE_CALL_A_TURN, batched_calls(max_tool_calls)) : append;
  return `${identity}\n\n${worded.trimEnd()}`;
}

/** The builder system prompt for the active provider: the `claude_cli`
 * prompt (implicit built-in tools, "the current working directory") for the
 * CLI builder, which never takes an injected set, or the local prompt naming
 * the seat's tool set for every provider that runs volley's tool loop,
 * `openrouter` included. Mirrors the critic's `resolve_critic_prompt`. */
function resolve_builder_system(config: ResolvedConfig, tool_set?: ToolSet): string {
  return config.builder_provider === 'claude_cli'
    ? compose_builder_system()
    : compose_builder_system_local(tool_set, config.builder_max_tool_calls);
}

// Salvage budget for a tool call a local model emits as assistant text instead
// of a structured tool_call (Hermes / json-fenced / Qwen3-Coder XML). Must be
// > 0 to turn salvage on; the budget is shared across the whole
// generate call and each salvage is observable on the result for the
// salvage-rate health metric.
const BUILDER_TOOL_CALL_REPAIR_ATTEMPTS = 3;

/** How the step countdown tells the builder to run the check: the command
 * checkride's digest comes from, the configured command, or the project's own
 * tests when no check gates the run. */
function check_hint(config: ResolvedConfig): string {
  if (config.check_resolved === 'checkride') return 'the check (`pnpm check --digest`)';
  if (config.check_resolved === 'command') return `the check (\`${config.check}\`)`;
  return "the project's tests";
}

/** Per-provider tool wiring for the builder, mirroring `critic_tool_options`.
 * The `claude_cli` builder is confined at the CLI permission layer (allowlist +
 * permission mode) and brings its own built-in tools — this arm is unchanged
 * from v2, and takes no injected tools or approval handler. Every other
 * builder, local or `openrouter`, brings none, so volley supplies its whole
 * workspace tool surface (or the set the caller injected in its place, with
 * the handler that answers its approvals), the per-call loop knobs, the step
 * countdown (`./builder/countdown.ts`), and **no** schema (it produces a
 * workspace, not a verdict); per-call values win over engine defaults. */
function builder_tool_options(
  deps: BuilderDeps,
): Pick<
  GenerateOptions,
  | 'tools'
  | 'on_tool_approval'
  | 'provider_options'
  | 'max_steps'
  | 'tool_error_policy'
  | 'tool_call_repair_attempts'
  | 'max_tool_calls_per_step'
  | 'prepare_step'
> {
  const { config } = deps;
  const bash_executor = deps.bash_executor ?? null;
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
    tools:
      deps.tools === undefined
        ? builder_tools(
            build_root(config.workspace, config.worktree),
            bash_executor !== null ? { bash_executor } : {},
          )
        : [...deps.tools],
    ...(deps.on_tool_approval !== undefined ? { on_tool_approval: deps.on_tool_approval } : {}),
    max_steps: config.builder_max_steps,
    tool_error_policy: 'feed_back',
    tool_call_repair_attempts: BUILDER_TOOL_CALL_REPAIR_ATTEMPTS,
    max_tool_calls_per_step: config.builder_max_tool_calls,
    prepare_step: step_countdown(config.builder_max_steps, check_hint(config)),
  };
}

/** What the builder is told about the iteration before its own, besides the
 * critic's feedback. */
export type PreviousRound = {
  /** That iteration's check. Its output goes in the prompt when it failed. */
  check: CheckResult | null;
  /** The step limit that iteration's builder hit before it called finish, or
   * null when it stopped on its own. */
  step_limit_hit: number | null;
};

export type BuilderPromptInput = {
  task: string;
  criteria: string;
  feedback: string | null;
  iteration: number;
  checkride: boolean;
  previous: PreviousRound | null;
};

/** How much of the last check's output the builder's prompt carries: a few KB,
 * whatever the runner. checkride's digest already fits in 8 kB, and the builder
 * can run the check again for the rest. */
export const PREVIOUS_CHECK_MAX_CHARS = 6000;

/** The first `max` characters of `text`, saying where it was cut. */
function head(text: string, max: number, rest: string): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (cut at ${String(max)} characters; ${rest})`;
}

/** The last `max` characters of `text`, saying what came before was cut. */
function tail(text: string, max: number): string {
  return text.length <= max
    ? text
    : `… (the last ${String(max)} characters of ${String(text.length)})\n${text.slice(-max)}`;
}

/** The part of a failed check the builder reads first: checkride's digest,
 * else the start of each failing slot's raw output, else the end of a
 * command's output, where test runners and compilers sum up. */
function check_excerpt(check: CheckResult): string {
  const max = PREVIOUS_CHECK_MAX_CHARS;
  if (check.digest !== undefined) {
    return head(check.digest.trimEnd(), max, '.check/digest.md has the rest');
  }
  if (check.detail.length > 0) {
    const slots = check.detail.map((artifact) => {
      const source = artifact.path === null ? '' : ` (.check/${basename(artifact.path)})`;
      return `${artifact.slot}${source}:\n${artifact.content.trimEnd()}`;
    });
    return head(slots.join('\n\n'), max, 'each slot\'s raw output under .check/ has the rest');
  }
  return tail((check.log ?? '').trimEnd(), max);
}

/** The check section of a later iteration's prompt: what the deterministic
 * gate itself said about the last session's work, so the builder starts from
 * its words rather than the critic's account of them, or re-running it to
 * find out. Empty unless that check ran and failed. */
function previous_check_section(check: CheckResult | null): string[] {
  if (check === null || !check.ran || check.ok) return [];
  const runner = check.runner === 'checkride' ? 'checkride, ' : '';
  const exit = check.exit_code === null ? 'no exit code' : `exit ${String(check.exit_code)}`;
  const lines = [
    '',
    'PREVIOUS CHECK RESULT',
    '---------------------',
    `The check failed on the work your last session left (${runner}${exit}).`,
  ];
  if (check.failing_slots.length > 0) {
    lines.push(`Failing slots: ${check.failing_slots.join(', ')}.`);
  }
  const excerpt = check_excerpt(check);
  if (excerpt.length > 0) lines.push('', excerpt);
  return lines;
}

/** The line a later iteration's prompt carries when the last session ran out
 * of steps: it never got to verify, so this one should check first. */
function step_limit_lines(step_limit_hit: number | null): string[] {
  if (step_limit_hit === null) return [];
  return [
    '',
    `Your last session hit its ${String(step_limit_hit)}-step limit before it called finish, so`,
    'it may never have verified its work. Run the check first this time, and keep',
    'enough steps in hand to verify again before you finish.',
  ];
}

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
  if (input.iteration > 1 && input.previous !== null) {
    parts.push(
      ...previous_check_section(input.previous.check),
      ...step_limit_lines(input.previous.step_limit_hit),
    );
  }
  if (input.checkride) {
    parts.push(
      '',
      'The definition of done for this workspace includes `pnpm check` (checkride)',
      'exiting 0. Run `pnpm check --digest` after each batch of edits and again',
      'before you finish. When it fails, read .check/digest.md first: it lists',
      'each failing slot\'s first findings. Open a slot\'s raw output under .check/',
      'only if the digest isn\'t enough, then fix and re-run.',
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
  /** The `bash` executor for a sandboxed local builder (`docker exec` against
   * the run's container), or null to use the host `spawnSync` default (the
   * unsandboxed escape hatch, or `claude_cli` which supplies no volley tools). */
  bash_executor?: BashExecutor | null;
  /** Tools to hand the builder in place of volley's own set; absent, it gets
   * that set. A `claude_cli` builder brings its own tools and never takes
   * these. */
  tools?: ReadonlyArray<Tool>;
  /** Which set `tools` is, so the prompt names the tools the builder holds;
   * absent, volley's own. */
  tool_set?: ToolSet;
  /** Answers each call to a tool that asks first (`needs_approval`). Like
   * `tools`, it reaches every builder but `claude_cli`. Absent, such a call
   * fails closed. */
  on_tool_approval?: ToolApprovalHandler;
};

/** The builder's model boundary: one call is one complete agentic session in
 * the build root, and its output is the whole `GenerateResult`, because the
 * phase records usage, cost, timing, and tool calls from it. */
export type BuilderStep = Step<ModelCallInput, GenerateResult>;

/** Build the builder leaf for this run. Everything but the prompt is fixed for
 * the whole run, so it is wired once here: the provider's system prompt, its
 * tool surface, and the live chunk stream to the renderer. */
export function make_builder_step(deps: BuilderDeps): BuilderStep {
  const { config } = deps;
  return model_call({
    engine: deps.engine,
    id: 'builder',
    description: 'model call: one agentic session in the build root',
    provider: config.builder_provider,
    model: config.builder_model,
    system: resolve_builder_system(config, deps.tool_set),
    on_chunk: deps.on_chunk,
    ...builder_tool_options(deps),
  });
}

export type BuilderRunDeps = {
  builder: BuilderStep;
  config: ResolvedConfig;
  warn: (message: string) => void;
};

/** Run one builder session on the opened iteration `state`, told what the
 * iteration before it left behind (`previous`, null on the first). */
export async function run_builder(
  deps: BuilderRunDeps,
  state: LoopState,
  previous: PreviousRound | null,
  ctx: RunContext,
): Promise<LoopState> {
  const { config } = deps;
  try {
    // Warn at builder start where a too-small context window is detectable —
    // it silently truncates tool schemas (the #1 local tool-calling failure) —
    // then pre-load the model so a cold multi-GB load doesn't blow the real
    // call's first-byte timeout. Both best-effort and Ollama-only; neither
    // blocks the build. Both go to the builder seat's own server.
    if (config.builder_provider === 'ollama') {
      const base_url = seat_base_url('ollama', config.builder_url, process.env);
      await warn_small_local_context(
        config.builder_provider,
        config.builder_model,
        base_url,
        deps.warn,
        ctx.abort,
      );
      await prewarm_ollama_model(base_url, config.builder_model, ctx.abort);
    }
    const result = await ctx.call(
      deps.builder,
      compose_builder_prompt({
        task: config.prompt,
        criteria: config.criteria,
        feedback: state.feedback,
        iteration: state.iteration,
        checkride: config.check_resolved === 'checkride',
        previous,
      }),
    );
    const built = accumulate(state, 'builder', result, config.builder_model);
    // `max_steps` is a backstop, not a failure — surface it, count it, and
    // carry on.
    if (result.finish_reason !== 'max_steps') return built;
    deps.warn(builder_max_steps_warning(config.builder_max_steps));
    return { ...built, builder_max_steps_hits: built.builder_max_steps_hits + 1 };
  } catch (err) {
    throw phase_error('builder', state.iteration, err);
  }
}
