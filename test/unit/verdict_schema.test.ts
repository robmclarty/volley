import { describe, expect, it } from 'vitest';
import { verdict_schema } from '../../src/critic/run.js';

describe('verdict_schema', () => {
  it('accepts an approval', () => {
    const parsed = verdict_schema.safeParse({
      verdict: 'approved',
      feedback: 'All criteria met.',
      unmet_criteria: [],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts changes_requested with unmet criteria', () => {
    const parsed = verdict_schema.safeParse({
      verdict: 'changes_requested',
      feedback: '- fix the tests',
      unmet_criteria: ['tests pass'],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects invalid verdict values', () => {
    for (const verdict of ['APPROVED', 'rejected', '', null, 42]) {
      const parsed = verdict_schema.safeParse({
        verdict,
        feedback: 'x',
        unmet_criteria: [],
      });
      expect(parsed.success).toBe(false);
    }
  });

  it('rejects missing fields', () => {
    expect(verdict_schema.safeParse({ verdict: 'approved' }).success).toBe(false);
    expect(
      verdict_schema.safeParse({ verdict: 'approved', feedback: 'ok' }).success,
    ).toBe(false);
    expect(verdict_schema.safeParse({}).success).toBe(false);
  });

  it('rejects non-string unmet_criteria entries', () => {
    const parsed = verdict_schema.safeParse({
      verdict: 'changes_requested',
      feedback: 'x',
      unmet_criteria: [1, 2],
    });
    expect(parsed.success).toBe(false);
  });
});
