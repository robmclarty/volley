/**
 * The history trim through fascicle's real tool loop: what each turn's
 * request sends, and that it keeps the prefix a local runtime caches between
 * the trim's boundary moves. Then the builder seat's own wiring of it.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { run } from 'fascicle';
import type { GenerateOptions, Message, Tool, TurnRequest } from 'fascicle';
import { assert_prefix_stable, make_loop_engine } from 'fascicle/testing';
import { make_builder_step } from '../../src/builder.js';
import { step_trim } from '../../src/builder/trim.js';
import type { ResolvedConfig } from '../../src/types.js';
import { temp_workspace, test_config } from '../helpers/harness.js';
import { mock_engine } from '../helpers/mock_engine.js';

const BIG = 'x'.repeat(4000);

const read_file: Tool = {
  name: 'read_file',
  description: 'Read a file.',
  input_schema: z.object({ path: z.string() }),
  execute: () => BIG,
};

function stubs_in(request: TurnRequest): number {
  return request.messages.filter(
    (m) => m.role === 'tool' && m.content.startsWith('[volley]'),
  ).length;
}

describe('the history trim in a real tool loop', () => {
  it('keeps each request a prefix of the next between boundary moves, and breaks it only at one', async () => {
    const turns = [
      ...Array.from({ length: 40 }, (_, t) => [{ name: 'read_file', input: { path: `f${String(t % 5)}.ts` } }]),
      'done',
    ];
    const loop = make_loop_engine(turns);
    const result = await loop.engine.generate({
      prompt: 'TASK: read the files',
      tools: [read_file],
      max_steps: 50,
      prepare_step: step_trim(12_000),
    });
    expect(result.content).toBe('done');

    const requests = loop.requests;
    // Some requests went out trimmed, and the boundary moved more than once.
    const counts = requests.map(stubs_in);
    expect(counts.at(-1)).toBeGreaterThan(0);
    const moves = counts.filter((count, i) => i > 0 && count !== counts[i - 1]).length;
    expect(moves).toBeGreaterThan(1);

    // Between moves, every request starts with the one before it.
    let start = 0;
    for (let i = 1; i <= requests.length; i += 1) {
      if (i === requests.length || counts[i] !== counts[start]) {
        assert_prefix_stable(requests.slice(start, i));
        start = i;
      }
    }
    // Across a move, it doesn't, which is the one re-prefill a move costs.
    expect(() => assert_prefix_stable(requests)).toThrow();

    // The transcript itself is the model's own: no stub ever reached it.
    expect(JSON.stringify(result.steps)).not.toContain('[volley]');
  });
});

describe("the builder seat's history trim", () => {
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

  /** A transcript of `turns` large reads. */
  function transcript(turns: number): Message[] {
    const messages: Message[] = [{ role: 'user', content: 'TASK ...' }];
    for (let t = 0; t < turns; t += 1) {
      const id = `c${String(t)}`;
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool_call', id, name: 'read_file', input: { path: `f${String(t)}.ts` } }],
      });
      messages.push({ role: 'tool', tool_call_id: id, name: 'read_file', content: BIG });
    }
    return messages;
  }

  it('trims, then counts down, on every tool-loop builder when it is on', async () => {
    for (const builder_provider of ['ollama', 'lmstudio', 'openrouter'] as const) {
      const opts = await builder_opts({ builder_provider, builder_max_steps: 30, builder_trim_history: 100 });
      const messages = transcript(28);
      const prepared = await opts?.prepare_step?.({ step_index: 28, messages });
      const sent = prepared?.messages ?? [];
      expect(sent.some((m) => m.role === 'tool' && m.content.startsWith('[volley] read_file')), builder_provider).toBe(true);
      // The countdown's note still goes last, after the trimmed transcript.
      expect(sent).toHaveLength(messages.length + 1);
      expect(sent.at(-1)?.content).toContain('2 steps left');
    }
  });

  it('is off by default: the countdown alone, and the transcript as written', async () => {
    const opts = await builder_opts({ builder_provider: 'ollama', builder_max_steps: 30 });
    const messages = transcript(28);
    const prepared = await opts?.prepare_step?.({ step_index: 28, messages });
    expect(prepared?.messages?.slice(0, messages.length)).toEqual(messages);
    expect(await opts?.prepare_step?.({ step_index: 3, messages })).toBeUndefined();
  });

  it('stays off the claude_cli builder, which runs its own loop', async () => {
    const opts = await builder_opts({ builder_provider: 'claude_cli', builder_trim_history: 100 });
    expect(opts?.prepare_step).toBeUndefined();
  });
});
