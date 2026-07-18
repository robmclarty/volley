/**
 * Critic invocation (spec §6): a read-only `claude_cli` session returning a
 * schema-validated structured verdict. The harness — not the critic — writes
 * `.volley/feedback.md` and `.volley/verdict`.
 */
import { z } from 'zod';
import type { Engine, GenerateOptions, GenerateResult, StreamChunk } from 'fascicle';
import type { RunContext } from 'fascicle';
import { accumulate } from '../cost.js';
import { resolve_ollama_base_url } from '../engine.js';
import { prewarm_ollama_model } from '../prewarm.js';
import { error_kind, phase_error } from '../types.js';
import type { CauseKind, LoopState, ResolvedConfig } from '../types.js';
import { build_root } from '../worktree.js';
import { compose_critic_prompt, resolve_critic_prompt } from './prompt.js';
import { read_only_tools, workspace_inventory } from './tools.js';

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
 * path at all.
 *
 * The two providers also enforce `verdict_schema` by two different paths, both
 * verified live (v3 R4/R5). The claude_cli critic compiles the schema for
 * `claude --json-schema`; that only works because fascicle 0.9.5's
 * `compile_schema` strips the top-level `$schema`/`$id` that zod v4 stamps (the
 * CLI rejects them) — `live_smoke` asserts a structured verdict comes back, so a
 * future fascicle regression there fails loudly rather than silently. The local
 * (ollama/lmstudio) critic instead gets Ollama **constrained decode** —
 * fascicle's ai_sdk default whenever a `schema` is passed — so the verdict is
 * structurally guaranteed at decode time, with no prompt-parse-repair;
 * `live_local_builder` exercises that path. Unchanged in v3: on ai_sdk
 * constrained decode needs no wiring, and under the deferred native flip (D2) it
 * would move to `provider_options.ollama.format` (Q5, parked). */
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
  // Read the builder's actual output: under `--worktree` (s2 D3) that lives in
  // the worktree, so the local critic's read tools resolve through the same
  // re-pointed containment root as the builder's writes.
  return { tools: read_only_tools(build_root(config.workspace, config.worktree)) };
}

/** Degradation ladder rung 1 (D1/OQ-11): how many times a local critic's call
 * is retried on a provider stream death before the ladder moves on. Capped at
 * one — the qwen3.6/Ollama tool-XML parser death is stochastic, so a same-call
 * retry often passes; past one attempt the failure is not transient and the
 * tool-less fallback (OQ-12) must take over. */
export const MAX_CRITIC_RETRIES = 1;

/** Is this critic failure the transient local-provider stream death the ladder
 * retries? Local providers only (D2 — the `claude_cli` path is proven and its
 * retries cost real money), fascicle's typed `provider_error` only (D8 — no
 * message string-matching), and never a user abort, which must stay exit-130. */
function is_retryable_critic_error(
  config: ResolvedConfig,
  ctx: RunContext,
  err: unknown,
): boolean {
  if (config.critic_provider === 'claude_cli') return false;
  if (ctx.abort.aborted) return false;
  return error_kind(err) === 'provider_error';
}

/** fascicle's `provider_error.cause_kind` is `... | undefined`; fold the
 * missing case into `'unknown'` so a recorded retry always names a cause (D8). */
function retry_cause_kind_of(err: unknown): CauseKind {
  const cause = (err as { cause_kind?: unknown }).cause_kind;
  return cause === 'provider_5xx' || cause === 'network' ? cause : 'unknown';
}

/** Bookkeeping stamped onto a critic record by the degradation ladder: how many
 * tool-bearing retries preceded this verdict, the last retry's cause, and — on the
 * tool-less rung — the `critic_degraded` mark (D3/D8). */
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
): LoopState {
  const next = accumulate(state, 'critic', result, model);
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
 * read tools are gone this pass and a paths+sizes workspace inventory (D4/D9), so
 * the critic still judges from the criteria, the raw check artifacts already in
 * the prompt, and the file layout — grounded, just shallower. */
function toolless_critic_prompt(config: ResolvedConfig, tool_prompt: string): string {
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

/** What the `--dry-run` canary learned about the critic seat (D5, amended
 * Q6/Q7): `ok` — the tool-bearing call came back; `degraded` — the tool-bearing
 * call died on a provider stream error but a tool-less pass survived, so a real
 * run will likely finish via the fallback ladder (`critic_degraded`);
 * `failed` — even the tool-less pass died, so the combo would fail a real run
 * degraded or not. */
export type CanaryOutcome =
  | { outcome: 'ok' }
  | { outcome: 'degraded'; detail: string }
  | { outcome: 'failed'; detail: string };

/** The canary must *elicit a real tool call* (D5): the qwen3.6 death happens at
 * tool-markup emission inside Ollama's server-side parser, so a call that never
 * invokes a tool could not fail and would prove nothing. The target path need
 * not exist — a tool error is fed back and the model answers anyway; entering
 * the parser is the test. No token cap: the budget is behavioral (one tool call,
 * then an immediate one-word verdict), because a hard `max_tokens` could
 * truncate a thinking model mid-verdict and report `failed` for a combo that
 * works. A model that skips the tool and just answers passes stochastically —
 * acceptable per D5: the canary is early warning, the ladder is the guarantee. */
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
 * The `--dry-run` critic-seat canary (D5): one tiny generate through the *real*
 * production tool wiring (`critic_tool_options`) and `verdict_schema`, $0 on a
 * local model. The caller (preflight) gates it to local critics only —
 * `claude_cli` is proven and its calls cost real money (D2).
 *
 * A tool-bearing death is classified by the same discriminant as the run-time
 * ladder (D8: typed `provider_error` only), then probed tool-less exactly as
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

export async function run_critic(
  deps: CriticDeps,
  state: LoopState,
  ctx: RunContext,
): Promise<LoopState> {
  const { engine, config } = deps;
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
    // Shared across every rung of the ladder; only the prompt and the tool
    // wiring differ between the tool-bearing attempts and the tool-less fallback.
    const base: Omit<GenerateOptions<VerdictOutput>, 'prompt' | 'tools' | 'provider_options'> = {
      provider: config.critic_provider,
      model: config.critic_model,
      system: resolve_critic_prompt(config),
      schema: verdict_schema,
      abort: ctx.abort,
      trajectory: ctx.trajectory,
      on_chunk: deps.on_chunk,
    };
    const tool_prompt = compose_critic_prompt({
      criteria: config.criteria,
      iteration: state.iteration,
      check,
    });

    // Rung 1 (D1/OQ-11): retry a local critic's stochastic tool-phase stream
    // death once before the fallback trades read access for survival. `attempt`
    // is also the retry count folded into the record: 0 on a first-try success.
    // A non-retryable failure (schema, abort, claude_cli) throws straight through
    // to `phase_error`; a retryable one exhausted at the last attempt falls out of
    // the loop to rung 2 rather than throwing.
    let retry_cause_kind: CauseKind | undefined;
    for (let attempt = 0; attempt <= MAX_CRITIC_RETRIES; attempt += 1) {
      try {
        const result = await engine.generate({
          ...base,
          prompt: tool_prompt,
          ...critic_tool_options(config),
        });
        return finalize_critic(state, result, config.critic_model, {
          retries: attempt,
          retry_cause_kind,
        });
      } catch (err) {
        if (!is_retryable_critic_error(config, ctx, err)) throw err;
        retry_cause_kind = retry_cause_kind_of(err);
      }
    }

    // Rung 2 (D3/D4/D9/OQ-12): every tool-bearing attempt died on a retryable
    // local provider stream error, so run one tool-less pass — no tools enter
    // Ollama's broken parser, constrained decode (`schema`) still guarantees the
    // verdict, and the workspace inventory keeps it grounded. Marked
    // `critic_degraded`. A death here throws → the outer catch → `phase_error`,
    // so exit-6 semantics are preserved (C4).
    const result = await engine.generate({
      ...base,
      prompt: toolless_critic_prompt(config, tool_prompt),
    });
    return finalize_critic(state, result, config.critic_model, {
      retries: MAX_CRITIC_RETRIES,
      retry_cause_kind,
      critic_degraded: true,
    });
  } catch (err) {
    throw phase_error('critic', state.iteration, err);
  }
}
