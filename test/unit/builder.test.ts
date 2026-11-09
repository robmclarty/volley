/**
 * The effort ladder's rules, apart from the flow: which rung build *k* runs
 * at, why it climbed, and the builder leaf built for each rung.
 */
import { describe, expect, it } from 'vitest';
import { make_builder_ladder, make_builder_step } from '../../src/builder.js';
import { skipped_check } from '../../src/check/command.js';
import { climb_reason, initial_state, rung_for_build } from '../../src/loop_state.js';
import type { CheckResult, EffortRung, LoopState } from '../../src/types.js';
import { test_config } from '../helpers/harness.js';
import { mock_engine } from '../helpers/mock_engine.js';

const LADDER: EffortRung[] = ['low', 'medium', 'high'];

const FAILED: CheckResult = {
  ran: true,
  runner: 'command',
  ok: false,
  exit_code: 1,
  duration_ms: 1,
  failing_slots: [],
  detail: [],
};

/** The state a build left behind, with its check and the critic's verdict. */
function left(check: CheckResult | null, verdict: LoopState['verdict']): LoopState {
  return { ...initial_state(), iteration: 1, builds: 1, check, verdict };
}

describe('rung_for_build', () => {
  it('runs build k at ladder[min(k, len) - 1]', () => {
    expect([1, 2, 3, 4, 9].map((k) => rung_for_build(LADDER, k))).toEqual([
      'low',
      'medium',
      'high',
      'high',
      'high',
    ]);
  });

  it('repeats a ladder of one, and gives no rung without a ladder', () => {
    expect([1, 2, 3].map((k) => rung_for_build(['max'], k))).toEqual(['max', 'max', 'max']);
    expect(rung_for_build(null, 1)).toBeNull();
    expect(rung_for_build([], 1)).toBeNull();
  });
});

describe('climb_reason', () => {
  it('names a failed check first, and the critic otherwise', () => {
    expect(climb_reason(LADDER, 2, left(FAILED, 'changes_requested'))).toBe('check_failed');
    expect(climb_reason(LADDER, 2, left(skipped_check('none'), 'changes_requested'))).toBe(
      'critic_rejected',
    );
    // A resumed run keeps the check but not the verdict.
    expect(climb_reason(LADDER, 3, left(null, null))).toBe('critic_rejected');
  });

  it("is null for the first build, once the top rung repeats, and with no ladder", () => {
    const rejected = left(skipped_check('none'), 'changes_requested');
    expect(climb_reason(LADDER, 1, rejected)).toBeNull();
    expect(climb_reason(LADDER, 4, rejected)).toBeNull();
    expect(climb_reason(['max'], 2, rejected)).toBeNull();
    expect(climb_reason(null, 2, rejected)).toBeNull();
  });
});

describe('make_builder_ladder', () => {
  const deps = () => ({
    engine: mock_engine(() => ({ content: 'built' })),
    on_chunk: () => undefined,
  });

  it('builds one leaf per rung, each with the id builder, and reuses it', () => {
    const ladder = make_builder_ladder({ ...deps(), config: test_config({ workspace: '/tmp', effort_ladder: LADDER }) });
    const low = ladder.at('low');
    const high = ladder.at('high');
    expect(low).not.toBe(high);
    expect(ladder.at('low')).toBe(low);
    expect(ladder.arm).toBe(low);
    expect([low.id, high.id]).toEqual(['builder', 'builder']);
    expect((low as { config?: { effort?: unknown } }).config?.effort).toBe('low');
    expect((high as { config?: { effort?: unknown } }).config?.effort).toBe('high');
  });

  it('builds the leaf with no effort at all when there is no ladder', () => {
    const config = test_config({ workspace: '/tmp' });
    const ladder = make_builder_ladder({ ...deps(), config });
    const plain = (ladder.arm as { config?: Record<string, unknown> }).config;
    expect(plain).not.toHaveProperty('effort');
    expect(plain).toEqual(
      (make_builder_step({ ...deps(), config }) as { config?: Record<string, unknown> }).config,
    );
  });
});
