import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_USAGE } from '../../src/cost.js';
import {
  combo_config,
  failure_reason,
  parse_model_list,
  parse_repeat,
  render_matrix_table,
  run_matrix,
} from '../../src/matrix.js';
import { worktree_fate } from '../../src/worktree.js';
import type { ComboRunner, MatrixCombo, MatrixRow } from '../../src/matrix.js';
import { create_renderer } from '../../src/render/renderer.js';
import type { CheckTrajectoryPoint, RunSummary } from '../../src/summary.js';
import type { RunStatus, VolleyConfig } from '../../src/types.js';

/** A stubbed enriched summary; only the fields the table reads matter. Mirrors
 * `build_run_summary`: a non-success run reports `iterations_to_converge: null`. */
function stub_summary(fields: {
  status?: RunStatus;
  iterations?: number;
  wall_clock_ms?: number;
  cost_usd?: number;
  salvage_rate?: number;
  critic_degraded?: boolean;
  gate_edits?: string[];
  unmet_criteria?: string[];
  check_trajectory?: CheckTrajectoryPoint[];
}): RunSummary {
  const status = fields.status ?? 'success';
  const converged = status === 'success';
  const iterations = fields.iterations ?? 1;
  const cost = fields.cost_usd ?? 0;
  return {
    run_id: 'stub',
    status,
    started_at: '2026-07-18T00:00:00.000Z',
    completed_at: '2026-07-18T00:02:00.000Z',
    iterations_completed: iterations,
    total_usage: EMPTY_USAGE,
    total_cost_usd: cost,
    builder_cost_usd: cost,
    critic_cost_usd: 0,
    check_duration_ms: 0,
    final_verdict: converged ? 'approved' : null,
    salvaged_branch: null,
    comparison: {
      builder_transport: 'ai_sdk',
      critic_transport: 'ai_sdk',
      iterations_to_converge: converged ? iterations : null,
      wall_clock_ms: fields.wall_clock_ms ?? 120_000,
      total_cost_usd: cost,
      builder_cost_usd: cost,
      critic_cost_usd: 0,
      final_verdict: converged ? 'approved' : null,
      check_trajectory: fields.check_trajectory ?? [],
      gate_edits: fields.gate_edits ?? [],
      unmet_criteria: fields.unmet_criteria ?? [],
      local_salvage: {
        tool_calls: 10,
        salvaged_tool_calls: (fields.salvage_rate ?? 0) * 10,
        rate: fields.salvage_rate ?? 0,
      },
      critic_degraded: fields.critic_degraded ?? false,
    },
  };
}

function check_point(ok: boolean, failing_slots: string[] = []): CheckTrajectoryPoint {
  return { iteration: 1, ran: true, ok, failing_slots };
}

const base_config: VolleyConfig = {
  prompt: 'do the thing',
  workspace: '/tmp/unused-by-stub',
  criteria: 'the thing is done',
};

function silent(): ReturnType<typeof create_renderer> {
  return create_renderer({ mode: 'json', show_thinking: false, color: false, max_cost_usd: null, write: () => {} });
}

function stub_row(overrides: Partial<MatrixRow> = {}): MatrixRow {
  return {
    builder: 'b',
    critic: 'c',
    runs: 1,
    converged: 1,
    mean_iterations: 1,
    mean_wall_clock_ms: 145_619,
    mean_cost_usd: 0,
    salvage_rate: 0.3,
    critic_degraded: true,
    gate_edits: [],
    reason: null,
    attempts: [],
    ...overrides,
  };
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

describe('parse_repeat', () => {
  it('defaults to one attempt per seat', () => {
    expect(parse_repeat(undefined)).toBe(1);
  });

  it('accepts a positive integer from either a flag or a config value', () => {
    expect(parse_repeat(3)).toBe(3);
    expect(parse_repeat('5')).toBe(5);
  });

  it('refuses zero, negatives, and fractions before any spend', () => {
    expect(() => parse_repeat(0)).toThrow(/--repeat/);
    expect(() => parse_repeat(-2)).toThrow(/positive integer/);
    expect(() => parse_repeat(1.5)).toThrow(/positive integer/);
    expect(() => parse_repeat('many')).toThrow(/positive integer/);
  });
});

describe('combo_config', () => {
  it('forces a throw-away worktree per seat: no branch kept, nothing integrated', () => {
    const config = combo_config(base_config, { builder: 'b1', critic: 'c1' });
    expect(config.builder_model).toBe('b1');
    expect(config.critic_model).toBe('c1');
    expect(config.worktree).toBe(true);
    expect(config.discard_worktree).toBe(true);
    expect(
      worktree_fate({
        worktree: true,
        git_checkpoints: config.git_checkpoints ?? false,
        discard_worktree: true,
      }),
    ).toBe('discard');
  });
});

describe('failure_reason', () => {
  it('is null for a converged run', () => {
    expect(failure_reason(stub_summary({}))).toBeNull();
  });

  it('names the failing check slots over anything else', () => {
    const reason = failure_reason(
      stub_summary({
        status: 'budget_exhausted',
        check_trajectory: [check_point(false, ['types', 'test'])],
        unmet_criteria: ['a criterion'],
      }),
    );
    expect(reason).toBe('check: types, test');
  });

  it('falls back to the criteria the critic still judged unmet', () => {
    expect(
      failure_reason(
        stub_summary({
          status: 'budget_exhausted',
          check_trajectory: [check_point(true)],
          unmet_criteria: ['the CLI exits 1 on bad input'],
        }),
      ),
    ).toBe('unmet: the CLI exits 1 on bad input');
  });

  it('counts instead of listing when several criteria are unmet', () => {
    expect(
      failure_reason(
        stub_summary({ status: 'budget_exhausted', unmet_criteria: ['one', 'two', 'three'] }),
      ),
    ).toBe('unmet: 3 criteria');
  });

  it('clips a long criterion to a table-sized cell', () => {
    const reason = failure_reason(
      stub_summary({ status: 'budget_exhausted', unmet_criteria: ['x'.repeat(200)] }),
    );
    expect(reason?.length).toBeLessThanOrEqual(44);
    expect(reason?.endsWith('…')).toBe(true);
  });

  it('names the halts that explain themselves', () => {
    expect(failure_reason(stub_summary({ status: 'cost_cap_reached' }))).toBe('cost cap');
    expect(failure_reason(stub_summary({ status: 'interrupted' }))).toBe('interrupted');
    expect(
      failure_reason(
        stub_summary({ status: 'gate_edit_blocked', gate_edits: ['test/a.test.mjs'] }),
      ),
    ).toBe('gate edit: test/a.test.mjs');
  });

  it('says the run errored when there is nothing more specific', () => {
    expect(failure_reason(stub_summary({ status: 'error' }))).toBe('run error');
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
      runs: 1,
      converged: 1,
      mean_iterations: 1,
      mean_wall_clock_ms: 90_000,
      salvage_rate: 0,
      critic_degraded: false,
      reason: null,
    });
    expect(rows[1]).toMatchObject<Partial<MatrixRow>>({
      critic: 'degraded-critic',
      mean_iterations: 2,
      mean_wall_clock_ms: 145_619,
      salvage_rate: 0.3,
      critic_degraded: true,
    });
  });

  describe('repeats', () => {
    it('runs each seat --repeat times and reports a pass rate, not a verdict', async () => {
      // Converges on attempts 1 and 3, not 2: the stochastic seat that n=1
      // would have called either "works" or "broken" depending on the draw.
      const run_combo: ComboRunner = async (_base, _combo, _renderer, attempt) =>
        attempt === 2
          ? stub_summary({
              status: 'budget_exhausted',
              wall_clock_ms: 200_000,
              check_trajectory: [check_point(false, ['test'])],
            })
          : stub_summary({ iterations: attempt, wall_clock_ms: 100_000 * attempt });
      const { rows, ok } = await run_matrix({
        base: base_config,
        builders: ['b'],
        critics: ['c'],
        matrix_dir,
        renderer: silent(),
        repeat: 3,
        run_combo,
      });
      const row = rows[0];
      expect(ok).toBe(true);
      expect(row).toMatchObject<Partial<MatrixRow>>({ runs: 3, converged: 2 });
      // Iterations average over the *converged* attempts only (1 and 3).
      expect(row?.mean_iterations).toBe(2);
      // Wall clock averages over every attempt that reported one.
      expect(row?.mean_wall_clock_ms).toBe(200_000);
      // The last non-converged attempt's reason survives into the row.
      expect(row?.reason).toBe('check: test');
      expect(row?.attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
      expect(row?.attempts.map((a) => a.converged)).toEqual([true, false, true]);
    });

    it('keeps every attempt\'s run state, not just the last', async () => {
      const run_combo: ComboRunner = async (_base, _combo, _renderer, attempt) =>
        stub_summary({ iterations: attempt });
      await run_matrix({
        base: base_config,
        builders: ['qwen3.6:latest'],
        critics: ['glm-4.7-flash'],
        matrix_dir,
        renderer: silent(),
        repeat: 2,
        run_combo,
      });
      const cell = join(matrix_dir, 'qwen3.6_latest__glm-4.7-flash');
      const first = JSON.parse(readFileSync(join(cell, 'run-01', 'summary.json'), 'utf8')) as RunSummary;
      const second = JSON.parse(readFileSync(join(cell, 'run-02', 'summary.json'), 'utf8')) as RunSummary;
      expect(first.comparison.iterations_to_converge).toBe(1);
      expect(second.comparison.iterations_to_converge).toBe(2);
    });

    it('weighs salvage by tool calls across attempts, not by averaging rates', async () => {
      const run_combo: ComboRunner = async (_base, _combo, _renderer, attempt) =>
        stub_summary({ salvage_rate: attempt === 1 ? 0.4 : 0 });
      const { rows } = await run_matrix({
        base: base_config,
        builders: ['b'],
        critics: ['c'],
        matrix_dir,
        renderer: silent(),
        repeat: 2,
        run_combo,
      });
      // 4 salvaged of 20 total tool calls.
      expect(rows[0]?.salvage_rate).toBeCloseTo(0.2);
    });

    it('unions gate edits and degradation across a seat\'s attempts', async () => {
      const run_combo: ComboRunner = async (_base, _combo, _renderer, attempt) =>
        attempt === 1
          ? stub_summary({ gate_edits: ['test/a.test.mjs'], critic_degraded: true })
          : stub_summary({ gate_edits: ['package.json'] });
      const { rows } = await run_matrix({
        base: base_config,
        builders: ['b'],
        critics: ['c'],
        matrix_dir,
        renderer: silent(),
        repeat: 2,
        run_combo,
      });
      expect(rows[0]?.gate_edits).toEqual(['package.json', 'test/a.test.mjs']);
      expect(rows[0]?.critic_degraded).toBe(true);
    });
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
    expect(rows[1]).toMatchObject({ runs: 1, converged: 0, mean_iterations: null });
    expect(rows[1]?.attempts[0]?.error).toBeNull();
  });

  it('marks an attempt that produces no summary as broke and fails the sweep', async () => {
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
    expect(rows[0]).toMatchObject({ converged: 1 });
    expect(rows[1]?.attempts[0]).toMatchObject({ status: 'broke', error: 'endpoint down' });
    expect(rows[1]?.reason).toContain('endpoint down');
    // A broken attempt writes no run state.
    expect(existsSync(join(matrix_dir, 'b__dead'))).toBe(false);
    expect(existsSync(join(matrix_dir, 'b__live', 'run-01', 'summary.json'))).toBe(true);
  });

  it('survives a seat that breaks on one attempt but runs on another', async () => {
    const run_combo: ComboRunner = async (_base, _combo, _renderer, attempt) => {
      if (attempt === 1) throw new Error('model still loading');
      return stub_summary({});
    };
    const { rows, ok } = await run_matrix({
      base: base_config,
      builders: ['b'],
      critics: ['c'],
      matrix_dir,
      renderer: silent(),
      repeat: 2,
      run_combo,
    });
    expect(ok).toBe(false);
    expect(rows[0]).toMatchObject({ runs: 2, converged: 1 });
  });

  it('writes the whole sweep as one machine-readable document', async () => {
    const run_combo: ComboRunner = async () => stub_summary({ iterations: 3 });
    await run_matrix({
      base: base_config,
      builders: ['b'],
      critics: ['c'],
      matrix_dir,
      renderer: silent(),
      run_combo,
    });
    const written = JSON.parse(readFileSync(join(matrix_dir, 'matrix.json'), 'utf8')) as {
      combos: MatrixRow[];
    };
    expect(written.combos).toHaveLength(1);
    expect(written.combos[0]?.attempts[0]?.iterations_to_converge).toBe(3);
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
    expect(captured).toContain('pass');
    expect(captured).toContain('why');
  });
});

describe('render_matrix_table', () => {
  it('renders header, a rule, and one line per row', () => {
    const table = render_matrix_table([stub_row({ mean_cost_usd: 0.7734 })]);
    const lines = table.split('\n');
    expect(lines[0]).toContain('builder');
    expect(lines[0]).toContain('pass');
    expect(lines).toHaveLength(3); // header + separator + one row
    expect(lines[2]).toContain('1/1');
    expect(lines[2]).toContain('145.6s');
    expect(lines[2]).toContain('$0.77');
    expect(lines[2]).toContain('30%');
    expect(lines[2]).toContain('deg');
  });

  it('shows a pass rate over repeats and the reason it was not 3/3', () => {
    const row = render_matrix_table([
      stub_row({ runs: 3, converged: 2, mean_iterations: 1.5, reason: 'check: types, test' }),
    ]).split('\n')[2] ?? '';
    expect(row).toContain('2/3');
    expect(row).toContain('1.5');
    expect(row).toContain('check: types, test');
  });

  it('flags a seat whose builder edited the gate', () => {
    const row = render_matrix_table([
      stub_row({ critic_degraded: false, gate_edits: ['test/a.test.mjs'] }),
    ]).split('\n')[2] ?? '';
    expect(row).toContain('gate');
  });

  it('dashes out the metric cells of a seat that never produced a summary', () => {
    const row = render_matrix_table([
      stub_row({
        runs: 1,
        converged: 0,
        mean_iterations: null,
        mean_wall_clock_ms: null,
        mean_cost_usd: null,
        salvage_rate: null,
        critic_degraded: false,
        reason: 'broke: boom',
      }),
    ]).split('\n')[2] ?? '';
    expect(row).toContain('0/1');
    expect(row).toContain('—');
    expect(row).toContain('broke: boom');
  });
});
