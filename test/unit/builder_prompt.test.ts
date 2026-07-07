import { describe, expect, it } from 'vitest';
import { compose_builder_prompt } from '../../src/builder.js';

const base = {
  task: 'implement the widget',
  criteria: '- widget works',
  feedback: null,
  iteration: 1,
  checkride: false,
};

describe('compose_builder_prompt', () => {
  it('first iteration has no feedback section', () => {
    const prompt = compose_builder_prompt(base);
    expect(prompt).toContain('TASK');
    expect(prompt).toContain('implement the widget');
    expect(prompt).toContain('ACCEPTANCE CRITERIA');
    expect(prompt).toContain('- widget works');
    expect(prompt).toContain('ITERATION: 1');
    expect(prompt).not.toContain('PREVIOUS CRITIC FEEDBACK');
    expect(prompt).not.toContain('pnpm check');
  });

  it('later iterations embed the critic feedback verbatim', () => {
    const prompt = compose_builder_prompt({
      ...base,
      iteration: 2,
      feedback: '- the widget is broken\n- fix the spinner',
    });
    expect(prompt).toContain('ITERATION: 2');
    expect(prompt).toContain('PREVIOUS CRITIC FEEDBACK');
    expect(prompt).toContain('- the widget is broken\n- fix the spinner');
    expect(prompt).toContain('workspace already contains your prior work');
  });

  it('includes the checkride stanza only when checkride is the runner', () => {
    const with_checkride = compose_builder_prompt({ ...base, checkride: true });
    expect(with_checkride).toContain('pnpm check');
    expect(with_checkride).toContain('.check/summary.json');

    const without = compose_builder_prompt(base);
    expect(without).not.toContain('.check/summary.json');
  });

  it('iteration > 1 with null feedback omits the feedback section', () => {
    const prompt = compose_builder_prompt({ ...base, iteration: 3, feedback: null });
    expect(prompt).not.toContain('PREVIOUS CRITIC FEEDBACK');
  });
});
