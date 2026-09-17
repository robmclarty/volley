import { describe, expect, it } from 'vitest';
import { gate, initial_state, status_of } from '../../src/orchestrator.js';
import { skipped_check } from '../../src/check/command.js';
import { test_config } from '../helpers/harness.js';
import type { CheckResult, LoopState, Verdict } from '../../src/types.js';

function check_result(ok: boolean): CheckResult {
  return {
    ran: true,
    runner: 'command',
    ok,
    exit_code: ok ? 0 : 1,
    duration_ms: 10,
    failing_slots: [],
    detail: [],
  };
}

function state_with(
  check: CheckResult | null,
  verdict: Verdict | null,
  total_cost_usd: number,
): LoopState {
  return { ...initial_state(), iteration: 1, check, verdict, total_cost_usd };
}

describe('gate', () => {
  const workspace = '/tmp';
  const uncapped = test_config({ workspace });
  const capped = test_config({ workspace, max_cost_usd: 1.0 });

  // Table-driven over (check.ok, verdict, cost, cap).
  const cases: Array<{
    name: string;
    check: CheckResult | null;
    verdict: Verdict | null;
    cost: number;
    cap: boolean;
    stop: boolean;
    halt: 'cost_cap' | null;
  }> = [
    { name: 'check ok + approved -> stop, success', check: check_result(true), verdict: 'approved', cost: 0.5, cap: false, stop: true, halt: null },
    { name: 'check ok + changes_requested -> continue', check: check_result(true), verdict: 'changes_requested', cost: 0.5, cap: false, stop: false, halt: null },
    { name: 'check failed + approved -> continue', check: check_result(false), verdict: 'approved', cost: 0.5, cap: false, stop: false, halt: null },
    { name: 'check failed + changes_requested -> continue', check: check_result(false), verdict: 'changes_requested', cost: 0.5, cap: false, stop: false, halt: null },
    { name: 'no check ran (none) + approved -> stop', check: skipped_check('none'), verdict: 'approved', cost: 0.5, cap: false, stop: true, halt: null },
    { name: 'cap crossed without success -> stop with halt', check: check_result(false), verdict: 'changes_requested', cost: 1.2, cap: true, stop: true, halt: 'cost_cap' },
    { name: 'cap exactly reached -> stop with halt', check: check_result(false), verdict: null, cost: 1.0, cap: true, stop: true, halt: 'cost_cap' },
    { name: 'success and cap on the same iteration -> success wins', check: check_result(true), verdict: 'approved', cost: 5.0, cap: true, stop: true, halt: null },
    { name: 'under cap, no verdict -> continue', check: check_result(false), verdict: null, cost: 0.5, cap: true, stop: false, halt: null },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const config = c.cap ? capped : uncapped;
      const { stop, state } = gate(config, state_with(c.check, c.verdict, c.cost));
      expect(stop).toBe(c.stop);
      expect(state.halt).toBe(c.halt);
    });
  }
});

describe('gate — gate edits (--fail-on-gate-edit)', () => {
  const workspace = '/tmp';
  const reporting = test_config({ workspace });
  const refusing = test_config({ workspace, fail_on_gate_edit: true });

  function state_with_gate_edits(gate_edits: string[]): LoopState {
    return {
      ...state_with(check_result(true), 'approved', 0.5),
      changes: {
        baseline: 'abc',
        files: gate_edits.map((path) => ({ path, status: 'modified' as const, gate: true })),
        gate_edits,
        total: gate_edits.length,
        truncated: false,
      },
    };
  }

  it('reports and converges by default: a gate edit is evidence, not a refusal', () => {
    const { stop, state } = gate(reporting, state_with_gate_edits(['test/a.test.mjs']));
    expect(stop).toBe(true);
    expect(state.halt).toBeNull();
  });

  it('beats success under the flag — the pass is what the edit puts in question', () => {
    const { stop, state } = gate(refusing, state_with_gate_edits(['test/a.test.mjs']));
    expect(stop).toBe(true);
    expect(state.halt).toBe('gate_edit');
  });

  it('lets a clean run through under the flag', () => {
    const { stop, state } = gate(refusing, state_with_gate_edits([]));
    expect(stop).toBe(true);
    expect(state.halt).toBeNull();
  });

  it('does not halt when change detection was unavailable', () => {
    const clean = { ...state_with(check_result(true), 'approved', 0.5), changes: null };
    expect(gate(refusing, clean).state.halt).toBeNull();
  });
});

describe('status_of', () => {
  it('maps loop outcomes to run statuses', () => {
    const s = initial_state();
    expect(status_of({ ...s, halt: null }, true)).toBe('success');
    expect(status_of({ ...s, halt: null }, false)).toBe('budget_exhausted');
    expect(status_of({ ...s, halt: 'cost_cap' }, true)).toBe('cost_cap_reached');
    // Wins over `converged`, which the guard set when it stopped the loop.
    expect(status_of({ ...s, halt: 'gate_edit' }, true)).toBe('gate_edit_blocked');
  });
});
