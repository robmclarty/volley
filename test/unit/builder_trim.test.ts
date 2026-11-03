import { describe, expect, it } from 'vitest';
import type { Message } from 'fascicle';
import {
  estimate_tokens,
  step_trim,
  STUB_MIN_CHARS,
  TRIM_KEEP_TURNS,
  TRIM_STRIDE_TURNS,
  trim_cutoff,
  trim_view,
} from '../../src/builder/trim.js';

const BIG = 'x'.repeat(4000);

/** A session transcript built turn by turn: each turn is one assistant tool
 * call and its result. */
function session() {
  const messages: Message[] = [{ role: 'user', content: 'TASK: build the ledger' }];
  let next_id = 0;
  return {
    messages,
    call(name: string, input: Record<string, unknown>, output: string, is_error = false): number {
      next_id += 1;
      const id = `c${String(next_id)}`;
      messages.push({ role: 'assistant', content: [{ type: 'tool_call', id, name, input }] });
      messages.push({ role: 'tool', tool_call_id: id, name, content: output, ...(is_error ? { is_error } : {}) });
      return messages.length - 1;
    },
  };
}

function content_at(messages: ReadonlyArray<Message>, i: number): string {
  const message = messages[i];
  return typeof message?.content === 'string' ? message.content : '';
}

describe('estimate_tokens', () => {
  it('counts characters over four, plus a little per message, tool call inputs included', () => {
    expect(estimate_tokens([{ role: 'user', content: 'x'.repeat(400) }])).toBe(108);
    const call: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'abcd' },
        { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.ts' } },
      ],
    };
    const chars = 4 + 'read_file'.length + JSON.stringify({ path: 'a.ts' }).length;
    expect(estimate_tokens([call])).toBe(Math.ceil(chars / 4) + 8);
  });
});

describe('trim_view', () => {
  it('stubs a read of a file a later call changed, naming the call', () => {
    const s = session();
    const read = s.call('read_file', { path: './src/a.ts' }, BIG);
    s.call('write_file', { path: 'src/a.ts', content: 'new' }, 'wrote 3 bytes to src/a.ts');
    const view = trim_view(s.messages, s.messages.length);
    expect(content_at(view, read)).toBe(
      '[volley] read_file src/a.ts (4000 chars) elided: a later write_file changed this file. Read it again for its current content.',
    );
  });

  it('says a read was repeated when a later whole read of the file comes before the cut', () => {
    const s = session();
    const first = s.call('read_file', { path: 'a.ts' }, BIG);
    const second = s.call('read_file', { path: 'a.ts' }, BIG);
    const view = trim_view(s.messages, s.messages.length);
    expect(content_at(view, first)).toContain('elided: it was read again later in this session');
    // The last read has nothing after it, so it's stubbed for its age.
    expect(content_at(view, second)).toBe(
      '[volley] read_file output (4000 chars) elided from an earlier turn. Run it again if you need it.',
    );
  });

  it("doesn't count a failed edit or a range read as superseding", () => {
    const s = session();
    const read = s.call('read_file', { path: 'a.ts' }, BIG);
    s.call('edit_file', { path: 'a.ts', old_str: 'x', new_str: 'y' }, 'error: old_str not found');
    s.call('edit_file', { path: 'a.ts', old_text: 'x', new_text: 'y' }, '{"error":"no match"}', true);
    const partial = s.call('read_file', { path: 'b.ts', offset: 10, limit: 20 }, BIG);
    s.call('read_file', { path: 'b.ts', offset: 40 }, BIG);
    const view = trim_view(s.messages, s.messages.length);
    expect(content_at(view, read)).toContain('elided from an earlier turn');
    expect(content_at(view, partial)).toContain('elided from an earlier turn');
  });

  it('lets a later edit supersede a range read', () => {
    const s = session();
    const partial = s.call('read_file', { path: 'b.ts', offset: 10 }, BIG);
    s.call('edit_file', { path: 'b.ts', old_text: 'x', new_text: 'y' }, 'edited b.ts');
    expect(content_at(trim_view(s.messages, s.messages.length), partial)).toContain(
      'a later edit_file changed this file',
    );
  });

  it("keeps a command's exit code in its stub", () => {
    const s = session();
    const run = s.call('bash', { command: 'node --test' }, JSON.stringify({ exit_code: 1, stdout: BIG, stderr: '' }));
    const plain = s.call('run_command', { command: 'ls' }, BIG);
    const view = trim_view(s.messages, s.messages.length);
    expect(content_at(view, run)).toMatch(/^\[volley\] bash output \(\d+ chars, exit 1\) elided from an earlier turn/);
    expect(content_at(view, plain)).toBe(
      '[volley] run_command output (4000 chars) elided from an earlier turn. Run it again if you need it.',
    );
  });

  it('leaves short results, failed calls, everything past the cut, and every non-tool message alone', () => {
    const s = session();
    const short = s.call('read_file', { path: 'a.ts' }, 'x'.repeat(STUB_MIN_CHARS));
    const failed = s.call('bash', { command: 'boom' }, BIG, true);
    const cut = s.messages.length;
    const after = s.call('read_file', { path: 'c.ts' }, BIG);
    const view = trim_view(s.messages, cut);
    expect(view).toHaveLength(s.messages.length);
    expect(view.map((m) => m.role)).toEqual(s.messages.map((m) => m.role));
    expect(view[short]).toBe(s.messages[short]);
    expect(view[failed]).toBe(s.messages[failed]);
    expect(view[after]).toBe(s.messages[after]);
    for (const [i, message] of s.messages.entries()) {
      if (message.role !== 'tool') expect(view[i]).toBe(message);
    }
  });

  it('reads only what comes before the cut, so a later write leaves the stub as it was', () => {
    const s = session();
    const read = s.call('read_file', { path: 'a.ts' }, BIG);
    const cut = s.messages.length;
    const before = content_at(trim_view(s.messages, cut), read);
    s.call('write_file', { path: 'a.ts', content: 'new' }, 'wrote 3 bytes to a.ts');
    expect(content_at(trim_view(s.messages, cut), read)).toBe(before);
  });
});

describe('trim_cutoff', () => {
  /** A session of `turns` turns, each a large read of its own file. */
  function long_session(turns: number) {
    const s = session();
    for (let t = 0; t < turns; t += 1) s.call('read_file', { path: `f${String(t)}.ts` }, BIG);
    return s.messages;
  }
  const turn_start = (messages: ReadonlyArray<Message>, turn: number) =>
    messages.flatMap((m, i) => (m.role === 'assistant' ? [i] : []))[turn];

  it('sends a request at or under the size whole', () => {
    const messages = long_session(30);
    expect(trim_cutoff(messages, estimate_tokens(messages))).toBeNull();
  });

  it('never cuts into the last turns, so a short session is sent whole however large', () => {
    const messages = long_session(TRIM_STRIDE_TURNS + TRIM_KEEP_TURNS - 1);
    expect(trim_cutoff(messages, 1)).toBeNull();
  });

  it('cuts at the first boundary, then the next only while still over the size', () => {
    const messages = long_session(3 * TRIM_STRIDE_TURNS + TRIM_KEEP_TURNS);
    expect(trim_cutoff(messages, 1)).toBe(turn_start(messages, 3 * TRIM_STRIDE_TURNS));
    // Trimmed at the first boundary, the request fits a size just above it.
    const at_first = estimate_tokens(trim_view(messages, turn_start(messages, TRIM_STRIDE_TURNS)!));
    expect(trim_cutoff(messages, at_first)).toBe(turn_start(messages, TRIM_STRIDE_TURNS));
  });

  it('keeps each request a prefix of the next between boundary moves, and moves only forward', () => {
    const s = session();
    const threshold = 12_000;
    let last_cutoff: number | null = null;
    let last_view: Message[] = [];
    let moves = 0;
    for (let t = 0; t < 60; t += 1) {
      s.call('read_file', { path: `f${String(t % 7)}.ts` }, BIG);
      const cutoff = trim_cutoff(s.messages, threshold);
      const view = cutoff === null ? [...s.messages] : trim_view(s.messages, cutoff);
      if (cutoff === last_cutoff) {
        expect(JSON.stringify(view.slice(0, last_view.length))).toBe(JSON.stringify(last_view));
      } else {
        moves += 1;
        expect(cutoff).not.toBeNull();
        if (last_cutoff !== null) expect(cutoff!).toBeGreaterThan(last_cutoff);
      }
      last_cutoff = cutoff;
      last_view = view;
    }
    // Sixty turns of 1,000-token reads move the boundary a handful of times,
    // not every turn.
    expect(moves).toBeGreaterThan(1);
    expect(moves).toBeLessThanOrEqual(Math.ceil(60 / TRIM_STRIDE_TURNS));
  });
});

describe('step_trim', () => {
  it('leaves a request under the size alone, and trims one over it', async () => {
    const s = session();
    for (let t = 0; t < 20; t += 1) s.call('read_file', { path: `f${String(t)}.ts` }, BIG);
    expect(await step_trim(1_000_000)({ step_index: 20, messages: s.messages })).toBeUndefined();
    const trimmed = await step_trim(1)({ step_index: 20, messages: s.messages });
    expect(trimmed?.messages).toHaveLength(s.messages.length);
    expect(estimate_tokens(trimmed!.messages!)).toBeLessThan(estimate_tokens(s.messages));
  });
});
