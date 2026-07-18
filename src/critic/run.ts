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
import { error_kind, phase_error } from '../types.js';
import type { CauseKind, LoopState, ResolvedConfig } from '../types.js';
import { build_root } from '../worktree.js';
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
    // Retry a local critic's stochastic stream death once (D1) before the
    // tool-less fallback (OQ-12) trades read access for survival. `attempt` is
    // also the retry count folded into the record: 0 on a first-try success.
    let retry_cause_kind: CauseKind | undefined;
    for (let attempt = 0; attempt <= MAX_CRITIC_RETRIES; attempt += 1) {
      try {
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
        const next = accumulate(state, 'critic', result, config.critic_model);
        return {
          ...next,
          critic:
            next.critic === null
              ? null
              : {
                  ...next.critic,
                  retries: attempt,
                  ...(retry_cause_kind !== undefined ? { retry_cause_kind } : {}),
                },
          verdict: result.content.verdict,
          feedback: result.content.feedback,
          unmet_criteria: result.content.unmet_criteria,
        };
      } catch (err) {
        if (attempt === MAX_CRITIC_RETRIES || !is_retryable_critic_error(config, ctx, err)) {
          throw err;
        }
        retry_cause_kind = retry_cause_kind_of(err);
      }
    }
    // The loop returns on success or throws on the last attempt; this line only
    // satisfies the type checker's need for a terminal statement.
    throw new Error('unreachable: critic retry loop exited without a result');
  } catch (err) {
    throw phase_error('critic', state.iteration, err);
  }
}
