import { describe, expect, it } from 'vitest';
import type { GenerateResult, StepRecord, ToolCallRecord } from 'fascicle';
import {
  accumulate,
  add_usage,
  cost_cap_hit,
  cost_source_of,
  phase_record,
  step_records,
} from '../../src/cost.js';
import { initial_state } from '../../src/loop_state.js';
import { test_config } from '../helpers/harness.js';

function result(overrides: Partial<GenerateResult<unknown>> = {}): GenerateResult<unknown> {
  return {
    content: 'done',
    tool_calls: [],
    steps: [],
    usage: { input_tokens: 100, output_tokens: 50 },
    cost: {
      total_usd: 0.25,
      input_usd: 0.15,
      output_usd: 0.1,
      currency: 'USD',
      is_estimate: true,
    },
    finish_reason: 'stop',
    model_resolved: { provider: 'claude_cli', model_id: 'opus' },
    provider_reported: { claude_cli: { session_id: 'abc', duration_ms: 900 } },
    ...overrides,
  };
}

describe('add_usage', () => {
  it('sums required fields and preserves optional ones only when present', () => {
    const sum = add_usage(
      { input_tokens: 10, output_tokens: 5 },
      { input_tokens: 1, output_tokens: 2, cached_input_tokens: 100 },
    );
    expect(sum).toEqual({
      input_tokens: 11,
      output_tokens: 7,
      cached_input_tokens: 100,
    });
    expect(sum.reasoning_tokens).toBeUndefined();
  });
});

describe('accumulate', () => {
  const config = test_config({ workspace: '/tmp' });

  it('folds builder and critic costs into per-role and run totals', () => {
    let state = { ...initial_state(), iteration: 1 };
    state = accumulate(state, 'builder', result(), config.builder_model, 1000);
    state = accumulate(
      state,
      'critic',
      result({ cost: { total_usd: 0.1, input_usd: 0.06, output_usd: 0.04, currency: 'USD', is_estimate: true } }),
      config.critic_model,
      1000,
    );
    expect(state.total_cost_usd).toBeCloseTo(0.35);
    expect(state.builder_cost_usd).toBeCloseTo(0.25);
    expect(state.critic_cost_usd).toBeCloseTo(0.1);
    expect(state.iteration_cost_usd).toBeCloseTo(0.35);
    expect(state.total_usage.input_tokens).toBe(200);
    expect(state.builder?.session_id).toBe('abc');
    expect(state.critic?.cost_source).toBe('provider_reported');
    expect(state.cost_warned).toBe(false);
  });

  it('records null cost and flags the warning when cost is unavailable', () => {
    let state = { ...initial_state(), iteration: 1 };
    const no_cost = result();
    delete (no_cost as { cost?: unknown }).cost;
    state = accumulate(state, 'builder', no_cost, 'opus', 1000);
    expect(state.builder?.cost_usd).toBeNull();
    expect(state.builder?.cost_source).toBe('unknown');
    expect(state.total_cost_usd).toBe(0);
    expect(state.cost_warned).toBe(true);

    // Totals keep summing what is known after a null.
    state = accumulate(state, 'critic', result(), 'opus', 1000);
    expect(state.total_cost_usd).toBeCloseTo(0.25);
  });
});

describe('cost_source_of / phase_record', () => {
  it('claude_cli and openrouter cost is provider_reported; other providers engine_derived', () => {
    expect(cost_source_of(result())).toBe('provider_reported');
    expect(
      cost_source_of(
        result({ model_resolved: { provider: 'openrouter', model_id: 'vendor/model' } }),
      ),
    ).toBe('provider_reported');
    for (const provider of ['anthropic', 'ollama', 'lmstudio']) {
      expect(cost_source_of(result({ model_resolved: { provider, model_id: 'x' } }))).toBe(
        'engine_derived',
      );
    }
    const no_cost = result();
    delete (no_cost as { cost?: unknown }).cost;
    expect(cost_source_of(no_cost)).toBe('unknown');
  });

  it('phase_record extracts session metadata with safe fallbacks', () => {
    const bare = result();
    delete (bare as { provider_reported?: unknown }).provider_reported;
    const record = phase_record(bare, 'opus', 4321);
    expect(record.session_id).toBeNull();
    expect(record.duration_ms).toBe(4321);
    expect(record.model).toBe('opus');
  });

  it('phase_record takes the call\'s measured timing, not the CLI\'s self-report', () => {
    // The fixture's claude_cli payload reports its own duration_ms of 900.
    const timed = result({ timing: { started_at: 0, duration_ms: 1500 } });
    const record = phase_record(timed, 'opus');
    expect(record.session_id).toBe('abc');
    expect(record.duration_ms).toBe(1500);
    // A caller that measured a wider span (the critic's whole ladder) wins.
    expect(phase_record(timed, 'opus', 4000).duration_ms).toBe(4000);
  });

  it('phase_record carries throughput when fascicle timed the turns, and omits it otherwise', () => {
    const turn = (output_tokens: number, duration_ms: number) => ({
      index: 0,
      text: '',
      tool_calls: [],
      usage: { input_tokens: 10, output_tokens },
      timing: { started_at: 0, duration_ms, first_chunk_ms: 500 },
      finish_reason: 'tool_calls' as const,
    });
    const timed = phase_record(
      result({
        model_resolved: { provider: 'ollama', model_id: 'qwen3.6' },
        steps: [turn(100, 2500), turn(50, 1500)],
      }),
      'qwen3.6',
      9000,
    );
    // 150 output tokens over the two decode windows (2000 + 1000 ms).
    expect(timed.throughput).toEqual({
      tokens_per_second: 50,
      basis: 'decode',
      output_tokens: 150,
      measured_ms: 3000,
    });
    // The wall clock and the model's own time are separate facts.
    expect(timed.duration_ms).toBe(9000);
    expect(phase_record(result(), 'opus', 1500).throughput).toBeUndefined();
  });

  it('phase_record captures finish_reason and counts salvaged tool calls', () => {
    const record = phase_record(
      result({
        finish_reason: 'max_steps',
        tool_calls: [
          { id: 'a', name: 'write_file', input: {}, duration_ms: 1, started_at: 0, salvaged: true },
          { id: 'b', name: 'bash', input: {}, duration_ms: 1, started_at: 0 },
          { id: 'c', name: 'edit_file', input: {}, duration_ms: 1, started_at: 0, salvaged: true },
        ],
      }),
      'qwen3-coder:30b',
      1000,
    );
    expect(record.finish_reason).toBe('max_steps');
    expect(record.tool_calls).toBe(3);
    expect(record.salvaged_tool_calls).toBe(2);
  });
});

describe('cost_cap_hit', () => {
  it('is false without a cap and compares >= with one', () => {
    const uncapped = test_config({ workspace: '/tmp' });
    const capped = test_config({ workspace: '/tmp', max_cost_usd: 1 });
    const state = { ...initial_state(), total_cost_usd: 1.0 };
    expect(cost_cap_hit(uncapped, state)).toBe(false);
    expect(cost_cap_hit(capped, state)).toBe(true);
    expect(cost_cap_hit(capped, { ...state, total_cost_usd: 0.99 })).toBe(false);
  });

  it('a $0 engine-derived phase records 0 (not null), stays un-warned, and does not trip the cap', () => {
    const capped = test_config({ workspace: '/tmp', max_cost_usd: 1 });
    let state = { ...initial_state(), iteration: 1 };
    state = accumulate(
      state,
      'builder',
      result({
        cost: { total_usd: 0, input_usd: 0, output_usd: 0, currency: 'USD', is_estimate: true },
        model_resolved: { provider: 'ollama', model_id: 'qwen3-coder:30b' },
      }),
      'qwen3-coder:30b',
      1000,
    );
    expect(state.builder?.cost_usd).toBe(0);
    expect(state.builder?.cost_source).toBe('engine_derived');
    expect(state.cost_warned).toBe(false);
    expect(state.total_cost_usd).toBe(0);
    expect(state.builder_cost_usd).toBe(0);
    expect(cost_cap_hit(capped, state)).toBe(false);
  });

  it('a null-cost phase neither trips nor disables the cap', () => {
    const capped = test_config({ workspace: '/tmp', max_cost_usd: 1 });
    let state = { ...initial_state(), iteration: 1 };
    const no_cost = result();
    delete (no_cost as { cost?: unknown }).cost;
    state = accumulate(state, 'builder', no_cost, 'qwen3-coder:30b', 1000);
    expect(cost_cap_hit(capped, state)).toBe(false);

    // The cap stays live: a later priced phase still counts toward it.
    state = accumulate(
      state,
      'critic',
      result({ cost: { total_usd: 1.5, input_usd: 0.9, output_usd: 0.6, currency: 'USD', is_estimate: true } }),
      'opus',
      1000,
    );
    expect(cost_cap_hit(capped, state)).toBe(true);
  });
});

describe('step_records', () => {
  function step(overrides: Partial<StepRecord> = {}): StepRecord {
    return {
      index: 0,
      text: '',
      tool_calls: [],
      usage: { input_tokens: 2600, output_tokens: 120 },
      timing: { started_at: 0, duration_ms: 5000, first_chunk_ms: 1800 },
      finish_reason: 'tool_calls',
      ...overrides,
    };
  }
  const call = (overrides: Partial<ToolCallRecord>): ToolCallRecord => ({
    id: 'c',
    name: 'read_file',
    input: {},
    duration_ms: 1,
    started_at: 0,
    ...overrides,
  });

  it("derives prefill from the ai_sdk transport's Ollama durations, which leave prompt_eval_duration out", () => {
    const [record] = step_records(
      result({
        steps: [
          step({
            provider_reported: {
              ollama: { total_duration: 5.2e9, load_duration: 0.2e9, eval_duration: 3e9 },
            },
          }),
        ],
      }),
    )!;
    expect(record).toMatchObject({
      input_tokens: 2600,
      output_tokens: 120,
      duration_ms: 5000,
      prefill_ms: 2000,
      decode_ms: 3000,
      timing_basis: 'ollama_derived',
    });
  });

  it("reads Ollama's own prompt_eval_duration when the native transport reports it", () => {
    const [record] = step_records(
      result({
        steps: [
          step({
            provider_reported: {
              ollama: {
                total_duration: 5.2e9,
                load_duration: 0.2e9,
                prompt_eval_duration: 1.9e9,
                eval_duration: 3e9,
              },
            },
          }),
        ],
      }),
    )!;
    expect(record).toMatchObject({ prefill_ms: 1900, decode_ms: 3000, timing_basis: 'ollama_reported' });
  });

  it('falls back to the first streamed chunk, and to no split for a tool call that arrived whole', () => {
    const records = step_records(
      result({
        steps: [
          step(),
          step({ index: 1, timing: { started_at: 0, duration_ms: 4000, first_chunk_ms: 3990, whole_tool_call: true } }),
          // Durations that don't add up are not split.
          step({ index: 2, provider_reported: { ollama: { total_duration: 1e9, load_duration: 0, eval_duration: 2e9 } } }),
        ],
      }),
    )!;
    expect(records[0]).toMatchObject({ prefill_ms: 1800, decode_ms: 3200, timing_basis: 'first_chunk' });
    expect(records[1]).toMatchObject({ timing_basis: 'none' });
    expect(records[1]).not.toHaveProperty('prefill_ms');
    expect(records[2]).toMatchObject({ prefill_ms: 1800, timing_basis: 'first_chunk' });
  });

  it('counts what each tool result put into the transcript, and keeps a truncated mark', () => {
    const [record] = step_records(
      result({
        steps: [
          step({
            truncated: true,
            finish_reason: 'length',
            tool_calls: [
              call({ name: 'read_file', output: 'abcdef' }),
              call({ name: 'bash', output: { exit_code: 0, stdout: 'ok', stderr: '' } }),
              call({ name: 'edit_file', error: { message: 'no match' } }),
            ],
          }),
        ],
      }),
    )!;
    expect(record!.truncated).toBe(true);
    expect(record!.finish_reason).toBe('length');
    expect(record!.tool_calls).toEqual([
      { name: 'read_file', output_chars: 6 },
      { name: 'bash', output_chars: JSON.stringify({ exit_code: 0, stdout: 'ok', stderr: '' }).length },
      { name: 'edit_file', output_chars: 'no match'.length },
    ]);
  });

  it('is undefined for a result with no steps, and only the builder record carries them', () => {
    expect(step_records(result())).toBeUndefined();
    const stepped = result({ steps: [step()] });
    const state = { ...initial_state(), iteration: 1 };
    expect(accumulate(state, 'builder', stepped, 'qwen', 1).builder?.steps).toHaveLength(1);
    expect(accumulate(state, 'critic', stepped, 'qwen', 1).critic).not.toHaveProperty('steps');
    expect(accumulate(state, 'builder', result(), 'opus', 1).builder).not.toHaveProperty('steps');
  });
});
