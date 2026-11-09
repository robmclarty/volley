/**
 * Cost and usage accumulation. All pricing knowledge lives in
 * fascicle; volley only folds `GenerateResult.usage` / `.cost` into loop
 * state and enforces the cap predicate in the guard.
 */
import { claude_cli_reported, throughput } from 'fascicle';
import type { GenerateResult, StepRecord, ToolCallRecord, UsageTotals } from 'fascicle';
import type {
  BuilderStepRecord,
  CostSource,
  LoopState,
  PhaseRecord,
  ResolvedConfig,
  StepTimingBasis,
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

/** The providers whose calls carry the charge they report, which fascicle
 * records as the call's cost in place of a pricing table's estimate: the
 * Claude CLI's own total, and OpenRouter's per-response charge. */
const REPORTING_PROVIDERS: ReadonlySet<string> = new Set(['claude_cli', 'openrouter']);

export function cost_source_of(result: GenerateResult<unknown>): CostSource {
  if (result.cost === undefined) return 'unknown';
  return REPORTING_PROVIDERS.has(result.model_resolved.provider)
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
  const truncated = result.steps.filter((step) => step.truncated === true).length;
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
    ...(truncated > 0 ? { truncated_turns: truncated } : {}),
    ...(rate !== undefined ? { throughput: rate } : {}),
  };
}

type StepSplit = { prefill_ms?: number; decode_ms?: number; timing_basis: StepTimingBasis };

const NS_PER_MS = 1e6;

function ns_field(payload: Record<string, unknown>, name: string): number | undefined {
  const value = payload[name];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A turn's prefill and decode times: Ollama's own durations when it reported
 * them (in ns), else the time to the first streamed chunk, else none. */
function step_split(step: StepRecord): StepSplit {
  const reported = step.provider_reported?.['ollama'];
  if (typeof reported === 'object' && reported !== null) {
    const ollama = reported as Record<string, unknown>;
    const evaluated = ns_field(ollama, 'eval_duration');
    const prompt = ns_field(ollama, 'prompt_eval_duration');
    if (evaluated !== undefined && prompt !== undefined) {
      return {
        prefill_ms: Math.round(prompt / NS_PER_MS),
        decode_ms: Math.round(evaluated / NS_PER_MS),
        timing_basis: 'ollama_reported',
      };
    }
    const total = ns_field(ollama, 'total_duration');
    const load = ns_field(ollama, 'load_duration');
    if (evaluated !== undefined && total !== undefined && load !== undefined && total >= load + evaluated) {
      return {
        prefill_ms: Math.round((total - load - evaluated) / NS_PER_MS),
        decode_ms: Math.round(evaluated / NS_PER_MS),
        timing_basis: 'ollama_derived',
      };
    }
  }
  const timing = step.timing;
  if (timing?.first_chunk_ms !== undefined && timing.whole_tool_call !== true) {
    return {
      prefill_ms: timing.first_chunk_ms,
      decode_ms: Math.max(0, timing.duration_ms - timing.first_chunk_ms),
      timing_basis: 'first_chunk',
    };
  }
  return { timing_basis: 'none' };
}

/** How much a tool call's result put into the transcript: its output as the
 * loop serializes it, or the error text it fed back. */
function output_chars(call: ToolCallRecord): number {
  if (call.output === undefined) return call.error?.message.length ?? 0;
  return typeof call.output === 'string' ? call.output.length : (JSON.stringify(call.output) ?? '').length;
}

/** Each turn of a session as the archive records it, or undefined when the
 * result has none. */
export function step_records(result: GenerateResult<unknown>): BuilderStepRecord[] | undefined {
  if (result.steps.length === 0) return undefined;
  return result.steps.map((step) => ({
    index: step.index,
    input_tokens: step.usage.input_tokens,
    output_tokens: step.usage.output_tokens,
    duration_ms: step.timing?.duration_ms ?? 0,
    ...step_split(step),
    finish_reason: step.finish_reason,
    ...(step.truncated === true ? { truncated: true as const } : {}),
    tool_calls: step.tool_calls.map((call) => ({ name: call.name, output_chars: output_chars(call) })),
  }));
}

/** Fold one phase's result into the loop state. Unknown cost records `null`
 * for the phase and warns once per run — a run never fails over pricing. The
 * builder's record also carries its session's turns. */
export function accumulate(
  state: LoopState,
  role: 'builder' | 'critic' | 'tester',
  result: GenerateResult<unknown>,
  model: string,
  duration_ms?: number,
): LoopState {
  const record = phase_record(result, model, duration_ms);
  const steps = role === 'builder' ? step_records(result) : undefined;
  const cost = record.cost_usd ?? 0;
  return {
    ...state,
    [role]: steps !== undefined ? { ...record, steps } : record,
    total_usage: add_usage(state.total_usage, result.usage),
    total_cost_usd: state.total_cost_usd + cost,
    iteration_cost_usd: state.iteration_cost_usd + cost,
    builder_cost_usd: state.builder_cost_usd + (role === 'builder' ? cost : 0),
    critic_cost_usd: state.critic_cost_usd + (role === 'critic' ? cost : 0),
    tester_cost_usd: state.tester_cost_usd + (role === 'tester' ? cost : 0),
    cost_warned: state.cost_warned || record.cost_usd === null,
  };
}

export function cost_cap_hit(config: ResolvedConfig, state: LoopState): boolean {
  return config.max_cost_usd !== null && state.total_cost_usd >= config.max_cost_usd;
}
