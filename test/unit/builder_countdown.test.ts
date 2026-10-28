import { describe, expect, it } from 'vitest';
import { run } from 'fascicle';
import type { GenerateOptions, Message } from 'fascicle';
import { make_builder_step } from '../../src/builder.js';
import { countdown_note, countdown_window, step_countdown } from '../../src/builder/countdown.js';
import type { BuilderProvider, ResolvedConfig } from '../../src/types.js';
import { temp_workspace, test_config } from '../helpers/harness.js';
import { mock_engine } from '../helpers/mock_engine.js';

const history: Message[] = [
  { role: 'user', content: 'TASK ...' },
  { role: 'assistant', content: 'reading' },
  { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'file' },
];

/** The text the hook appended for a turn, or undefined when it left the turn
 * alone. */
async function note_at(max_steps: number, step_index: number): Promise<string | undefined> {
  const prepared = await step_countdown(max_steps, 'the check (`pnpm exec checkride --digest`)')({
    step_index,
    messages: history,
  });
  if (prepared?.messages === undefined) return undefined;
  expect(prepared.messages.slice(0, history.length)).toEqual(history);
  const added = prepared.messages.slice(history.length);
  expect(added).toHaveLength(1);
  expect(added[0]?.role).toBe('user');
  return typeof added[0]?.content === 'string' ? added[0].content : undefined;
}

describe('countdown_window', () => {
  it('covers five steps, a tenth of a long budget, and never more than half', () => {
    expect(countdown_window(50)).toBe(5);
    expect(countdown_window(100)).toBe(10);
    expect(countdown_window(200)).toBe(20);
    expect(countdown_window(8)).toBe(4);
    expect(countdown_window(2)).toBe(1);
    expect(countdown_window(1)).toBe(0);
  });
});

describe('step_countdown', () => {
  it('leaves every turn before the window alone', async () => {
    for (const step_index of [0, 1, 20, 44]) {
      expect(await note_at(50, step_index)).toBeUndefined();
    }
  });

  it('appends the steps left, this one included, and how to check, in the window', async () => {
    const first = await note_at(50, 45);
    expect(first).toBe(countdown_note(5, 'the check (`pnpm exec checkride --digest`)'));
    expect(first).toContain('[volley] 5 steps left in this session, this one included');
    expect(first).toContain("If you haven't run the check (`pnpm exec checkride --digest`) since your last edit");
    expect(await note_at(50, 48)).toContain('2 steps left');
  });

  it('tells the last step that only finish runs', async () => {
    const last = await note_at(50, 49);
    expect(last).toContain('This is the last step of this session, and only finish runs on it');
    expect(last).toContain('Call finish now');
  });

  it('never counts down a one-step session', async () => {
    expect(await note_at(1, 0)).toBeUndefined();
  });
});

describe("the builder seat's countdown", () => {
  async function builder_opts(overrides: Partial<ResolvedConfig>): Promise<GenerateOptions<unknown> | undefined> {
    const { workspace, cleanup } = temp_workspace();
    try {
      const engine = mock_engine(() => ({ content: 'done' }));
      const config = test_config({ workspace, builder_model: 'builder-model', ...overrides });
      await run(make_builder_step({ engine, config, on_chunk: () => undefined }), 'build it', {
        install_signal_handlers: false,
      });
      return engine.calls[0]?.opts;
    } finally {
      cleanup();
    }
  }

  it('rides on every tool-loop builder, sized to its step budget and naming its check', async () => {
    for (const builder_provider of ['ollama', 'lmstudio', 'openrouter'] as const satisfies BuilderProvider[]) {
      const opts = await builder_opts({
        builder_provider,
        builder_max_steps: 17,
        check: 'npm test',
        check_resolved: 'command',
      });
      const hook = opts?.prepare_step;
      expect(hook, builder_provider).toBeDefined();
      expect(await hook?.({ step_index: 11, messages: history })).toBeUndefined();
      const prepared = await hook?.({ step_index: 12, messages: history });
      expect(prepared?.messages?.at(-1)?.content).toContain('5 steps left');
      expect(prepared?.messages?.at(-1)?.content).toContain('the check (`npm test`)');
    }
  });

  it("names volley's own checkride command, which needs no check script", async () => {
    const opts = await builder_opts({
      builder_provider: 'ollama',
      builder_max_steps: 10,
      check: 'auto',
      check_resolved: 'checkride',
    });
    const prepared = await opts?.prepare_step?.({ step_index: 6, messages: history });
    expect(prepared?.messages?.at(-1)?.content).toContain('the check (`pnpm exec checkride --digest`)');
  });

  it("names the project's tests when no check gates the run", async () => {
    const opts = await builder_opts({ builder_provider: 'ollama', builder_max_steps: 10 });
    const prepared = await opts?.prepare_step?.({ step_index: 6, messages: history });
    expect(prepared?.messages?.at(-1)?.content).toContain("If you haven't run the project's tests");
  });

  it('asks for the output cap, and to go on past a turn it cuts off, only when one is set', async () => {
    const capped = await builder_opts({ builder_provider: 'ollama', builder_max_output_tokens: 32768 });
    expect(capped?.max_tokens).toBe(32768);
    expect(capped?.truncated_turn_policy).toBe('continue');
    const uncapped = await builder_opts({ builder_provider: 'openrouter', builder_max_output_tokens: null });
    expect(uncapped?.max_tokens).toBeUndefined();
    expect(uncapped?.truncated_turn_policy).toBeUndefined();
  });

  it('stays off the claude_cli builder, which runs its own loop', async () => {
    const opts = await builder_opts({ builder_provider: 'claude_cli' });
    expect(opts?.prepare_step).toBeUndefined();
  });
});
