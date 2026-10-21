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

  it('reads null feedback and unmet_criteria as empty', () => {
    // A tool-using critic isn't constrain-decoded; GLM approved this way, and
    // the run used to exit 6 on the schema failure.
    const parsed = verdict_schema.safeParse({
      verdict: 'approved',
      feedback: null,
      unmet_criteria: null,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ verdict: 'approved', feedback: '', unmet_criteria: [] });
  });

  it('shows the model each field as its type or null, still required and described', () => {
    // What fascicle compiles: the schema's input side, at its default target.
    const json = verdict_schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' });
    expect(json['required']).toEqual(['verdict', 'feedback', 'unmet_criteria']);
    const properties = json['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['feedback']).toEqual({
      description: expect.stringContaining('Free-form markdown for the builder.'),
      anyOf: [{ type: 'string' }, { type: 'null' }],
    });
    expect(properties['unmet_criteria']).toEqual({
      description: expect.stringContaining('The specific acceptance criteria judged unmet'),
      anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }],
    });
  });
});
