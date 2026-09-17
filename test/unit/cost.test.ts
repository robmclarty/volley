import { describe, expect, it } from 'vitest';
import type { GenerateResult } from 'fascicle';
import {
  accumulate,
  add_usage,
  cost_cap_hit,
  cost_source_of,
  phase_record,
} from '../../src/cost.js';
import { initial_state } from '../../src/orchestrator.js';
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
    state = accumulate(state, 'builder', result(), config.builder_model);
    state = accumulate(
      state,
      'critic',
      result({ cost: { total_usd: 0.1, input_usd: 0.06, output_usd: 0.04, currency: 'USD', is_estimate: true } }),
      config.critic_model,
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
    state = accumulate(state, 'builder', no_cost, 'opus');
    expect(state.builder?.cost_usd).toBeNull();
    expect(state.builder?.cost_source).toBe('unknown');
    expect(state.total_cost_usd).toBe(0);
    expect(state.cost_warned).toBe(true);

    // Totals keep summing what is known after a null.
    state = accumulate(state, 'critic', result(), 'opus');
    expect(state.total_cost_usd).toBeCloseTo(0.25);
  });
});

describe('cost_source_of / phase_record', () => {
  it('claude_cli cost is provider_reported; other providers engine_derived', () => {
    expect(cost_source_of(result())).toBe('provider_reported');
    expect(
      cost_source_of(result({ model_resolved: { provider: 'anthropic', model_id: 'x' } })),
    ).toBe('engine_derived');
    const no_cost = result();
    delete (no_cost as { cost?: unknown }).cost;
    expect(cost_source_of(no_cost)).toBe('unknown');
  });

  it('phase_record extracts session metadata with safe fallbacks', () => {
    const bare = result();
    delete (bare as { provider_reported?: unknown }).provider_reported;
    const record = phase_record(bare, 'opus');
    expect(record.session_id).toBeNull();
    expect(record.duration_ms).toBe(0);
    expect(record.model).toBe('opus');
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
    state = accumulate(state, 'builder', no_cost, 'qwen3-coder:30b');
    expect(cost_cap_hit(capped, state)).toBe(false);

    // The cap stays live: a later priced phase still counts toward it.
    state = accumulate(
      state,
      'critic',
      result({ cost: { total_usd: 1.5, input_usd: 0.9, output_usd: 0.6, currency: 'USD', is_estimate: true } }),
      'opus',
    );
    expect(cost_cap_hit(capped, state)).toBe(true);
  });
});
