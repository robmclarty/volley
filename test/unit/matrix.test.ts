import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_USAGE } from '../../src/cost.js';
import {
  parse_model_list,
  render_matrix_table,
  run_matrix,
} from '../../src/matrix.js';
import type { ComboRunner, MatrixCombo, MatrixRow } from '../../src/matrix.js';
import { create_renderer } from '../../src/render/renderer.js';
import type { RunSummary } from '../../src/summary.js';
import type { RunStatus, VolleyConfig } from '../../src/types.js';

/** A stubbed enriched summary; only the fields the table reads matter. Mirrors
 * `build_run_summary`: a non-success run reports `iterations_to_converge: null`. */
function stub_summary(fields: {
  status?: RunStatus;
  iterations?: number;
  wall_clock_ms?: number;
  salvage_rate?: number;
  critic_degraded?: boolean;
}): RunSummary {
  const status = fields.status ?? 'success';
  const converged = status === 'success';
  const iterations = fields.iterations ?? 1;
  return {
    run_id: 'stub',
    status,
    started_at: '2026-07-18T00:00:00.000Z',
    completed_at: '2026-07-18T00:02:00.000Z',
    iterations_completed: iterations,
    total_usage: EMPTY_USAGE,
    total_cost_usd: 0,
    builder_cost_usd: 0,
    critic_cost_usd: 0,
    check_duration_ms: 0,
    final_verdict: converged ? 'approved' : null,
    comparison: {
      builder_transport: 'ai_sdk',
      critic_transport: 'ai_sdk',
      iterations_to_converge: converged ? iterations : null,
      wall_clock_ms: converged ? fields.wall_clock_ms ?? 120_000 : null,
      total_cost_usd: 0,
      builder_cost_usd: 0,
      critic_cost_usd: 0,
      final_verdict: converged ? 'approved' : null,
      check_trajectory: [],
      local_salvage: { tool_calls: 10, salvaged_tool_calls: 0, rate: fields.salvage_rate ?? 0 },
      critic_degraded: fields.critic_degraded ?? false,
    },
  };
}

const base_config: VolleyConfig = {
  prompt: 'do the thing',
  workspace: '/tmp/unused-by-stub',
  criteria: 'the thing is done',
};

function silent(): ReturnType<typeof create_renderer> {
  return create_renderer({ mode: 'json', show_thinking: false, color: false, max_cost_usd: null, write: () => {} });
}

describe('parse_model_list', () => {
  it('splits, trims, and drops empties', () => {
    expect(parse_model_list('a, b ,c', '--builders')).toEqual(['a', 'b', 'c']);
    expect(parse_model_list('qwen3.6:latest', '--critics')).toEqual(['qwen3.6:latest']);
  });

  it('refuses an empty or all-whitespace list', () => {
    expect(() => parse_model_list(undefined, '--builders')).toThrow(/--builders/);
    expect(() => parse_model_list(' , ', '--critics')).toThrow(/at least one model/);
  });
});

describe('run_matrix', () => {
  let matrix_dir: string;

  beforeEach(() => {
    matrix_dir = mkdtempSync(join(tmpdir(), 'volley-matrix-test-'));
  });
  afterEach(() => {
    rmSync(matrix_dir, { recursive: true, force: true });
  });

  it('runs the cross product serially in row-major order', async () => {
    const seen: MatrixCombo[] = [];
    const run_combo: ComboRunner = async (_base, combo) => {
      seen.push(combo);
      return stub_summary({});
    };
    const outcome = await run_matrix({
      base: base_config,
      builders: ['b1', 'b2'],
      critics: ['c1', 'c2'],
      matrix_dir,
      renderer: silent(),
      run_combo,
    });
    expect(outcome.ok).toBe(true);
    expect(seen).toEqual([
      { builder: 'b1', critic: 'c1' },
      { builder: 'b1', critic: 'c2' },
      { builder: 'b2', critic: 'c1' },
      { builder: 'b2', critic: 'c2' },
    ]);
    expect(outcome.rows.map((r) => `${r.builder}×${r.critic}`)).toEqual([
      'b1×c1',
      'b1×c2',
      'b2×c1',
      'b2×c2',
    ]);
  });

  it('sources each row from the combo comparison block', async () => {
    const run_combo: ComboRunner = async (_base, combo) =>
      combo.critic === 'degraded-critic'
        ? stub_summary({ iterations: 2, wall_clock_ms: 145_619, salvage_rate: 0.3, critic_degraded: true })
        : stub_summary({ iterations: 1, wall_clock_ms: 90_000, salvage_rate: 0 });
    const { rows } = await run_matrix({
      base: base_config,
      builders: ['builder'],
      critics: ['good-critic', 'degraded-critic'],
      matrix_dir,
      renderer: silent(),
      run_combo,
    });
    expect(rows[0]).toMatchObject<Partial<MatrixRow>>({
      critic: 'good-critic',
      status: 'success',
      iterations_to_converge: 1,
      wall_clock_ms: 90_000,
      salvage_rate: 0,
      critic_degraded: false,
    });
    expect(rows[1]).toMatchObject<Partial<MatrixRow>>({
      critic: 'degraded-critic',
      iterations_to_converge: 2,
      wall_clock_ms: 145_619,
      salvage_rate: 0.3,
      critic_degraded: true,
    });
  });

  it('writes per-combo run state under .volley-matrix/<builder>__<critic>/', async () => {
    const run_combo: ComboRunner = async () => stub_summary({ iterations: 3 });
    await run_matrix({
      base: base_config,
      builders: ['qwen3.6:latest'],
      critics: ['glm-4.7-flash'],
      matrix_dir,
      renderer: silent(),
      run_combo,
    });
    const path = join(matrix_dir, 'qwen3.6_latest__glm-4.7-flash', 'summary.json');
    expect(existsSync(path)).toBe(true);
    const written = JSON.parse(readFileSync(path, 'utf8')) as RunSummary;
    expect(written.comparison.iterations_to_converge).toBe(3);
  });

  it('keeps a non-converging combo as a result row and still exits ok', async () => {
    const run_combo: ComboRunner = async (_base, combo) =>
      combo.critic === 'weak'
        ? stub_summary({ status: 'budget_exhausted' })
        : stub_summary({});
    const { rows, ok } = await run_matrix({
      base: base_config,
      builders: ['b'],
      critics: ['strong', 'weak'],
      matrix_dir,
      renderer: silent(),
      run_combo,
    });
    expect(ok).toBe(true);
    expect(rows[1]).toMatchObject({ status: 'budget_exhausted', iterations_to_converge: null, error: null });
  });

  it('marks a combo that produces no summary as broke and fails the sweep', async () => {
    const run_combo: ComboRunner = async (_base, combo) => {
      if (combo.critic === 'dead') throw new Error('endpoint down');
      return stub_summary({});
    };
    const { rows, ok } = await run_matrix({
      base: base_config,
      builders: ['b'],
      critics: ['live', 'dead'],
      matrix_dir,
      renderer: silent(),
      run_combo,
    });
    expect(ok).toBe(false);
    expect(rows[0]).toMatchObject({ status: 'success' });
    expect(rows[1]).toMatchObject({ status: 'broke', error: 'endpoint down' });
    // A broken combo writes no run state.
    expect(existsSync(join(matrix_dir, 'b__dead'))).toBe(false);
    expect(existsSync(join(matrix_dir, 'b__live', 'summary.json'))).toBe(true);
  });

  it('emits one aggregate table to the renderer', async () => {
    let captured = '';
    const renderer = create_renderer({
      mode: 'default',
      show_thinking: false,
      color: false,
      max_cost_usd: null,
      write: (text) => {
        captured += text;
      },
    });
    const run_combo: ComboRunner = async () => stub_summary({});
    await run_matrix({
      base: base_config,
      builders: ['b'],
      critics: ['c'],
      matrix_dir,
      renderer,
      run_combo,
    });
    expect(captured).toContain('builder');
    expect(captured).toContain('degraded');
  });
});

describe('render_matrix_table', () => {
  it('renders header, a rule, and one line per row', () => {
    const table = render_matrix_table([
      {
        builder: 'b',
        critic: 'c',
        status: 'success',
        iterations_to_converge: 1,
        wall_clock_ms: 145_619,
        salvage_rate: 0.3,
        critic_degraded: true,
        error: null,
      },
    ]);
    const lines = table.split('\n');
    expect(lines[0]).toContain('builder');
    expect(lines[0]).toContain('degraded');
    expect(lines).toHaveLength(3); // header + separator + one row
    expect(lines[2]).toContain('145.6s');
    expect(lines[2]).toContain('30%');
    expect(lines[2]).toContain('yes');
  });

  it('dashes out the metric cells of a broke row', () => {
    const table = render_matrix_table([
      {
        builder: 'b',
        critic: 'c',
        status: 'broke',
        iterations_to_converge: null,
        wall_clock_ms: null,
        salvage_rate: null,
        critic_degraded: false,
        error: 'boom',
      },
    ]);
    const row = table.split('\n')[2] ?? '';
    expect(row).toContain('broke');
    expect(row).toContain('—');
  });
});
