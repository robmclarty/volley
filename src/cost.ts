/**
 * Cost and usage accumulation. All pricing knowledge lives in
 * fascicle; volley only folds `GenerateResult.usage` / `.cost` into loop
 * state and enforces the cap predicate in the guard.
 */
import { claude_cli_reported, throughput } from 'fascicle';
import type { GenerateResult, UsageTotals } from 'fascicle';
import type {
  CostSource,
  LoopState,
  PhaseRecord,
  ResolvedConfig,
} from './types.js';

export const EMPTY_USAGE: UsageTotals = { input_tokens: 0, output_tokens: 0 };

export function add_usage(a: UsageTotals, b: UsageTotals): UsageTotals {
  const sum: UsageTotals = {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  };
  const optional = ['cached_input_tokens', 'cache_write_tokens', 'reasoning_tokens'] as const;
  for (const key of optional) {
    const total = (a[key] ?? 0) + (b[key] ?? 0);
    if (a[key] !== undefined || b[key] !== undefined) sum[key] = total;
  }
  return sum;
}

export function cost_source_of(result: GenerateResult<unknown>): CostSource {
  if (result.cost === undefined) return 'unknown';
  return result.model_resolved.provider === 'claude_cli'
    ? 'provider_reported'
    : 'engine_derived';
}

/** One phase's record from its generate result. The duration is fascicle's
 * call-level wall clock (`GenerateResult.timing`: every turn and the tools
 * between them) unless the caller measured a wider span, as the critic does for
 * its whole degradation ladder. */
export function phase_record(
  result: GenerateResult<unknown>,
  model: string,
  duration_ms: number = result.timing?.duration_ms ?? 0,
): PhaseRecord {
  const rate = throughput(result);
  return {
    provider: result.model_resolved.provider,
    model,
    session_id: claude_cli_reported(result)?.session_id ?? null,
    duration_ms,
    usage: result.usage,
    cost_usd: result.cost?.total_usd ?? null,
    cost_source: cost_source_of(result),
    finish_reason: result.finish_reason,
    tool_calls: result.tool_calls.length,
    salvaged_tool_calls: result.tool_calls.filter((call) => call.salvaged === true).length,
    ...(rate !== undefined ? { throughput: rate } : {}),
  };
}

/** Fold one phase's result into the loop state. Unknown cost records `null`
 * for the phase and warns once per run — a run never fails over pricing. */
export function accumulate(
  state: LoopState,
  role: 'builder' | 'critic',
  result: GenerateResult<unknown>,
  model: string,
  duration_ms?: number,
): LoopState {
  const record = phase_record(result, model, duration_ms);
  const cost = record.cost_usd ?? 0;
  return {
    ...state,
    [role]: record,
    total_usage: add_usage(state.total_usage, result.usage),
    total_cost_usd: state.total_cost_usd + cost,
    iteration_cost_usd: state.iteration_cost_usd + cost,
    builder_cost_usd: state.builder_cost_usd + (role === 'builder' ? cost : 0),
    critic_cost_usd: state.critic_cost_usd + (role === 'critic' ? cost : 0),
    cost_warned: state.cost_warned || record.cost_usd === null,
  };
}

export function cost_cap_hit(config: ResolvedConfig, state: LoopState): boolean {
  return config.max_cost_usd !== null && state.total_cost_usd >= config.max_cost_usd;
}
