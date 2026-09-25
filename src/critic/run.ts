/**
 * Critic invocation: a read-only session (`claude_cli`, or a local model with
 * volley's read tools) returning a schema-validated structured verdict. The
 * harness — not the critic — writes `.volley/feedback.md` and `.volley/verdict`.
 */
import { z } from 'zod';
import { model_call } from 'fascicle';
import type {
  Engine,
  FallbackOutcome,
  GenerateOptions,
  GenerateResult,
  RetryOutcome,
  RunContext,
  Step,
  StreamChunk,
} from 'fascicle';
import { accumulate } from '../cost.js';
import { resolve_ollama_base_url } from '../engine.js';
import { prewarm_ollama_model } from '../prewarm.js';
import { error_kind, phase_error } from '../types.js';
import type { CauseKind, LoopState, ResolvedConfig } from '../types.js';
import { build_root } from '../worktree.js';
import { compose_critic_prompt, resolve_critic_prompt } from './prompt.js';
import { read_only_tools, workspace_inventory } from './tools.js';

const CRITIC_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob'] as const;

const CRITIC_DISALLOWED_TOOLS = 'Write,Edit,MultiEdit,NotebookEdit,Bash';

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
 * path at all.
 *
 * The two providers also enforce `verdict_schema` by two different paths, both
 * verified live. The claude_cli critic compiles the schema for
 * `claude --json-schema`; that only works because fascicle 0.12.9's
 * `compile_schema` strips the top-level `$schema`/`$id` that zod v4 stamps (the
 * CLI rejects them) — `live_smoke` asserts a structured verdict comes back, so a
 * future fascicle regression there fails loudly rather than silently. The local
 * (ollama/lmstudio) critic instead gets Ollama **constrained decode** —
 * fascicle's ai_sdk default whenever a `schema` is passed — so the verdict is
 * structurally guaranteed at decode time, with no prompt-parse-repair;
 * `live_local_builder` exercises that path. Unchanged in v3: on ai_sdk
 * constrained decode needs no wiring, and under the deferred native flip it
 * would move to `provider_options.ollama.format` (parked). */
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
  // Read the builder's actual output: under `--worktree` that lives in
  // the worktree, so the local critic's read tools resolve through the same
  // re-pointed containment root as the builder's writes.
  return { tools: read_only_tools(build_root(config.workspace, config.worktree)) };
}

/** Degradation ladder rung 1: how many times a local critic's call
 * is retried on a provider stream death before the ladder moves on. Capped at
 * one — the qwen3.6/Ollama tool-XML parser death is stochastic, so a same-call
 * retry often passes; past one attempt the failure is not transient and the
 * tool-less fallback must take over. */
export const MAX_CRITIC_RETRIES = 1;

/** Is this critic failure the transient local-provider stream death the ladder
 * retries? Local providers only (the `claude_cli` path is proven and its
 * retries cost real money), and fascicle's typed `provider_error` only (no
 * message string-matching). A user abort never gets here: `retry` and
 * `fallback` pass control-flow signals through untouched, and `retry` checks the
 * signal before every attempt, so an abort stays exit-130. */
function is_retryable_critic_error(config: ResolvedConfig, err: unknown): boolean {
  if (config.critic_provider === 'claude_cli') return false;
  return error_kind(err) === 'provider_error';
}

/** fascicle's `provider_error.cause_kind` is `... | undefined`; fold the
 * missing case into `'unknown'` so a recorded retry always names a cause. */
function retry_cause_kind_of(err: unknown): CauseKind {
  const cause = (err as { cause_kind?: unknown }).cause_kind;
  return cause === 'provider_5xx' || cause === 'network' ? cause : 'unknown';
}

/** Bookkeeping stamped onto a critic record by the degradation ladder: how many
 * tool-bearing retries preceded this verdict, the last retry's cause, and — on the
 * tool-less rung — the `critic_degraded` mark. */
type LadderMark = {
  retries: number;
  retry_cause_kind: CauseKind | undefined;
  critic_degraded?: boolean;
};

/** Fold a successful critic `generate` result into loop state, stamping the
 * ladder bookkeeping onto the critic record. Shared by the tool-bearing path and
 * the tool-less fallback so both shape the record identically (the fallback just
 * adds `critic_degraded: true`). */
function finalize_critic(
  state: LoopState,
  result: GenerateResult<VerdictOutput>,
  model: string,
  mark: LadderMark,
  duration_ms: number,
): LoopState {
  const next = accumulate(state, 'critic', result, model, duration_ms);
  return {
    ...next,
    critic:
      next.critic === null
        ? null
        : {
            ...next.critic,
            retries: mark.retries,
            ...(mark.retry_cause_kind !== undefined
              ? { retry_cause_kind: mark.retry_cause_kind }
              : {}),
            ...(mark.critic_degraded === true ? { critic_degraded: true } : {}),
          },
    verdict: result.content.verdict,
    feedback: result.content.feedback,
    unmet_criteria: result.content.unmet_criteria,
  };
}

/** The tool-less fallback's prompt: the normal critic prompt plus a notice that
 * read tools are gone this pass and a paths+sizes workspace inventory, so
 * the critic still judges from the criteria, the raw check artifacts already in
 * the prompt, and the file layout — grounded, just shallower. */
export function toolless_critic_prompt(config: ResolvedConfig, tool_prompt: string): string {
  return [
    tool_prompt,
    '',
    'NOTE: file-read tools are unavailable for this review. Judge from the',
    'acceptance criteria, the deterministic check output above, and the workspace',
    'file inventory below (paths and sizes only — file contents are not shown).',
    '',
    'WORKSPACE FILE INVENTORY',
    '------------------------',
    workspace_inventory(build_root(config.workspace, config.worktree)),
  ].join('\n');
}

/** What the critic arm answers with: the call that produced the verdict, and
 * how the ladder reached it. */
export type CriticAnswer = {
  result: GenerateResult<VerdictOutput>;
  mark: LadderMark;
};

/** The critic's model boundary: the whole degradation ladder behind one step
 * (composed in `../flow.ts`). */
export type CriticStep = Step<string, CriticAnswer>;

/** One critic call returning the validated verdict in its `GenerateResult`. */
export type CriticCall = Step<string, GenerateResult<VerdictOutput>>;

function critic_call_config(deps: CriticDeps) {
  const { config } = deps;
  return {
    engine: deps.engine,
    provider: config.critic_provider,
    model: config.critic_model,
    system: resolve_critic_prompt(config),
    schema: verdict_schema,
    on_chunk: deps.on_chunk,
  };
}

/** Rung 1's leaf: the critic with its read tools (or the CLI's read-only
 * allowlist). */
export function make_critic_tools_step(deps: CriticDeps): CriticCall {
  return model_call({
    ...critic_call_config(deps),
    id: 'critic_tools',
    ...critic_tool_options(deps.config),
  });
}

/** Rung 2's leaf: the same critic with no tools at all, so nothing enters
 * Ollama's broken tool parser; constrained decode (`schema`) still guarantees
 * the verdict. */
export function make_critic_toolless_step(deps: CriticDeps): CriticCall {
  return model_call({ ...critic_call_config(deps), id: 'critic_toolless' });
}

/** The ladder's retry predicate for this run's critic provider. */
export function critic_retryable(config: ResolvedConfig): (err: unknown) => boolean {
  return (err) => is_retryable_critic_error(config, err);
}

/** Rung 1's projection: a verdict the tool-bearing critic produced, marked with
 * how many stream deaths it took and the last one's cause. */
export function with_retries(outcome: RetryOutcome<GenerateResult<VerdictOutput>>): CriticAnswer {
  const last = outcome.errors.at(-1);
  return {
    result: outcome.value,
    mark: {
      retries: outcome.attempts - 1,
      retry_cause_kind: last === undefined ? undefined : retry_cause_kind_of(last),
    },
  };
}

/** Rung 2's answer: every retry was spent, and the verdict is marked degraded
 * so it never passes silently as a full critique. */
export function as_degraded(result: GenerateResult<VerdictOutput>): CriticAnswer {
  return {
    result,
    mark: { retries: MAX_CRITIC_RETRIES, retry_cause_kind: undefined, critic_degraded: true },
  };
}

/** The ladder's projection: the tool-less backup cannot see why it ran, so the
 * cause comes from the last stream death the retry rung gave up on. */
export function with_fallback_cause(outcome: FallbackOutcome<CriticAnswer>): CriticAnswer {
  if (outcome.source === 'primary') return outcome.value;
  return {
    ...outcome.value,
    mark: { ...outcome.value.mark, retry_cause_kind: retry_cause_kind_of(outcome.primary_error) },
  };
}

/** What the `--dry-run` canary learned about the critic seat:
 * `ok` — the tool-bearing call came back; `degraded` — the tool-bearing
 * call died on a provider stream error but a tool-less pass survived, so a real
 * run will likely finish via the fallback ladder (`critic_degraded`);
 * `failed` — even the tool-less pass died, so the combo would fail a real run
 * degraded or not. */
export type CanaryOutcome =
  | { outcome: 'ok' }
  | { outcome: 'degraded'; detail: string }
  | { outcome: 'failed'; detail: string };

/** The canary must *elicit a real tool call*: the qwen3.6 death happens at
 * tool-markup emission inside Ollama's server-side parser, so a call that never
 * invokes a tool could not fail and would prove nothing. The target path need
 * not exist — a tool error is fed back and the model answers anyway; entering
 * the parser is the test. No token cap: the budget is behavioral (one tool call,
 * then an immediate one-word verdict), because a hard `max_tokens` could
 * truncate a thinking model mid-verdict and report `failed` for a combo that
 * works. A model that skips the tool and just answers passes stochastically —
 * acceptable: the canary is early warning, the ladder is the guarantee. */
const CANARY_PROMPT = [
  'CANARY CHECK — a tiny wiring probe, not a real review.',
  'First, call the read_file tool on the path "package.json".',
  'Whatever the tool returns (content or an error), immediately answer with',
  'verdict "approved", feedback exactly "canary", and empty unmet_criteria.',
].join('\n');

/** The canary's tool-less rung: same schema-constrained call, no tool ask. */
const CANARY_TOOLLESS_PROMPT = [
  'CANARY CHECK — a tiny wiring probe, not a real review.',
  'Answer with verdict "approved", feedback exactly "canary", and empty',
  'unmet_criteria.',
].join('\n');

function canary_detail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The `--dry-run` critic-seat canary: one tiny generate through the *real*
 * production tool wiring (`critic_tool_options`) and `verdict_schema`, $0 on a
 * local model. The caller (preflight) gates it to local critics only —
 * `claude_cli` is proven and its calls cost real money.
 *
 * A tool-bearing death is classified by the same discriminant as the run-time
 * ladder (typed `provider_error` only), then probed tool-less exactly as
 * rung 2 would run, so the canary *predicts the ladder* instead of guessing:
 * tool-less survives → `degraded` (warn — the combo completes a real run,
 * marked); tool-less dies too → `failed` (the endpoint-down / model-missing
 * class that earns exit 5 because not even degradation would save it).
 */
export async function critic_canary(
  engine: Engine,
  config: ResolvedConfig,
  env: Record<string, string | undefined> = process.env,
): Promise<CanaryOutcome> {
  // Same cold-load guard as the real critic phase: without it a disk-cold model
  // would die on the first-byte timeout and the canary would cry wolf.
  if (config.critic_provider === 'ollama') {
    await prewarm_ollama_model(resolve_ollama_base_url(env), config.critic_model);
  }
  const base: Omit<GenerateOptions<VerdictOutput>, 'prompt' | 'tools' | 'provider_options'> = {
    provider: config.critic_provider,
    model: config.critic_model,
    system: resolve_critic_prompt(config),
    schema: verdict_schema,
  };
  try {
    await engine.generate({
      ...base,
      prompt: CANARY_PROMPT,
      ...critic_tool_options(config),
    });
    return { outcome: 'ok' };
  } catch (err) {
    if (error_kind(err) !== 'provider_error') {
      return { outcome: 'failed', detail: canary_detail(err) };
    }
    const tool_death = canary_detail(err);
    try {
      await engine.generate({ ...base, prompt: CANARY_TOOLLESS_PROMPT });
      return { outcome: 'degraded', detail: tool_death };
    } catch (fallback_err) {
      return { outcome: 'failed', detail: canary_detail(fallback_err) };
    }
  }
}

export type CriticRunDeps = {
  critic: CriticStep;
  config: ResolvedConfig;
};

export async function run_critic(
  deps: CriticRunDeps,
  state: LoopState,
  ctx: RunContext,
): Promise<LoopState> {
  const { config } = deps;
  if (state.check === null) {
    throw phase_error('critic', state.iteration, new Error('check phase did not run'));
  }
  const check = state.check;
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
    const prompt = compose_critic_prompt({
      criteria: config.criteria,
      iteration: state.iteration,
      check,
      changes: state.changes,
    });
    // The phase's duration spans every rung that ran, not just the call that
    // answered: a retried or degraded verdict took that long to get, and no one
    // result's `timing` covers the attempts before it.
    const started = Date.now();
    const { result, mark } = await ctx.call(deps.critic, prompt);
    return finalize_critic(state, result, config.critic_model, mark, Date.now() - started);
  } catch (err) {
    throw phase_error('critic', state.iteration, err);
  }
}
