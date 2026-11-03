import { describe, expect, it } from 'vitest';
import type { Message, PrepareStepHook } from 'fascicle';
import { compose_prepare_steps } from '../../src/builder/prepare_step.js';

const history: Message[] = [{ role: 'user', content: 'TASK ...' }];

const append = (text: string): PrepareStepHook => ({ messages }) => ({
  messages: [...messages, { role: 'user', content: text }],
});

const untouched: PrepareStepHook = () => undefined;

describe('compose_prepare_steps', () => {
  it('runs each hook on the request the one before it made, in order', async () => {
    const seen: number[] = [];
    const counting: PrepareStepHook = ({ messages }) => {
      seen.push(messages.length);
      return undefined;
    };
    const prepared = await compose_prepare_steps([append('first'), counting, append('last')])({
      step_index: 3,
      messages: history,
    });
    expect(seen).toEqual([2]);
    expect(prepared?.messages?.map((m) => m.content)).toEqual(['TASK ...', 'first', 'last']);
  });

  it('passes each hook the step index', async () => {
    const indexes: number[] = [];
    const hook: PrepareStepHook = ({ step_index }) => {
      indexes.push(step_index);
      return undefined;
    };
    await compose_prepare_steps([hook, hook])({ step_index: 7, messages: history });
    expect(indexes).toEqual([7, 7]);
  });

  it('reports no change when no hook made one', async () => {
    expect(await compose_prepare_steps([untouched, untouched])({ step_index: 0, messages: history })).toBeUndefined();
  });
});
