/**
 * Trimming a long tool-loop session's history (#7). Every turn resends the
 * whole session, every earlier `read_file` result included, even for files the
 * builder has rewritten since, so a long local session's requests grow
 * linearly and each turn's latency grows with them: volley-41806476's input
 * went from 2.6k to 57k tokens over 50 steps, and its turns from 3 s to as
 * much as 120 s.
 *
 * Above a size the operator sets (`--builder-trim-history`), each turn's
 * request replaces the older tool results with one-line stubs: a read of a
 * file a later call wrote, edited, or read whole says so, and any other result
 * names its call and size. The last `TRIM_KEEP_TURNS` turns, every assistant
 * and user message, every failed call's result, and anything short stay as
 * they are. It goes in through fascicle's `prepare_step`, which reshapes only
 * what one turn sends, so the transcript stays as the model wrote it.
 *
 * A local runtime reuses the KV cache for the prefix a request shares with
 * the last one, and rewriting an earlier message breaks that prefix, so the
 * window is prefilled again. So the trim moves in coarse steps: it stubs
 * everything before a turn boundary, boundaries fall every
 * `TRIM_STRIDE_TURNS` turns, and the boundary moves on only when the trimmed
 * request has grown past the size again. Between moves each request starts
 * with the same bytes as the last, since a stub depends only on what came
 * before its boundary and never on the step. The trim keeps no state:
 * `trim_cutoff` works the boundary out again from the transcript each turn.
 */
import { posix } from 'node:path';
import type { Message, PrepareStepHook } from 'fascicle';

/** A rough token count per character: the hook sees no token counts, so a
 * request's size is estimated from its text. */
const CHARS_PER_TOKEN = 4;

/** Turns at the end of a session whose tool results are never stubbed. */
export const TRIM_KEEP_TURNS = 6;

/** How many turns apart the boundaries the trim may cut at fall. */
export const TRIM_STRIDE_TURNS = 8;

/** Results this short are kept, since a stub would save next to nothing. */
export const STUB_MIN_CHARS = 200;

/** What a message costs beyond its text: its role and framing. */
const MESSAGE_OVERHEAD_TOKENS = 8;

/** The calls that change a file, whose success makes an earlier read of it
 * stale. Both volley's tools and fascicle's ACP tools use these names and a
 * `path` input. */
const FILE_WRITERS: ReadonlySet<string> = new Set(['write_file', 'edit_file']);

const COMMAND_TOOLS: ReadonlySet<string> = new Set(['bash', 'run_command']);

function message_chars(message: Message): number {
  if (typeof message.content === 'string') return message.content.length;
  let chars = 0;
  for (const part of message.content) {
    if (part.type === 'text' || part.type === 'reasoning') chars += part.text.length;
    else if (part.type === 'tool_call') chars += part.name.length + (JSON.stringify(part.input) ?? '').length;
  }
  return chars;
}

/** A request's size in tokens, estimated from its characters. */
export function estimate_tokens(messages: ReadonlyArray<Message>): number {
  let tokens = 0;
  for (const message of messages) {
    tokens += Math.ceil(message_chars(message) / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS;
  }
  return tokens;
}

/** What a tool call asked for, as far as the trim reads it. */
type CallInput = { path: string | null; whole: boolean };

function call_input(input: unknown): CallInput {
  if (typeof input !== 'object' || input === null) return { path: null, whole: true };
  const fields = input as Record<string, unknown>;
  const path = typeof fields['path'] === 'string' ? posix.normalize(fields['path']) : null;
  // An ACP read names a range with `offset` or `limit`; volley's never does.
  return { path, whole: fields['offset'] === undefined && fields['limit'] === undefined };
}

/** Each tool call's input, by call id, from the assistant messages in
 * `messages`. */
function call_inputs(messages: ReadonlyArray<Message>): Map<string, CallInput> {
  const inputs = new Map<string, CallInput>();
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') continue;
    for (const part of message.content) {
      if (part.type === 'tool_call') inputs.set(part.id, call_input(part.input));
    }
  }
  return inputs;
}

type ToolMessage = Extract<Message, { role: 'tool' }>;

/** A later call on a path that makes an earlier read of it stale. */
type Supersession = { tool: string; changed: boolean };

/** Whether this result is one whose call changed its file or read it whole. */
function supersession_of(message: ToolMessage, input: CallInput | undefined): Supersession | null {
  if (input === undefined || input.path === null || message.is_error === true) return null;
  if (FILE_WRITERS.has(message.name)) {
    return message.content.startsWith('error:') ? null : { tool: message.name, changed: true };
  }
  if (message.name === 'read_file' && input.whole) return { tool: 'read_file', changed: false };
  return null;
}

function exit_code_of(content: string): number | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null) {
      const code = (parsed as Record<string, unknown>)['exit_code'];
      if (typeof code === 'number') return code;
    }
  } catch {
    // Not JSON: a command result without an exit code to keep.
  }
  return null;
}

function stub(message: ToolMessage, input: CallInput | undefined, later: Supersession | undefined): string {
  const size = `${String(message.content.length)} chars`;
  if (later !== undefined && input !== undefined && input.path !== null) {
    return later.changed
      ? `[volley] read_file ${input.path} (${size}) elided: a later ${later.tool} changed this file. Read it again for its current content.`
      : `[volley] read_file ${input.path} (${size}) elided: it was read again later in this session.`;
  }
  const exit_code = COMMAND_TOOLS.has(message.name) ? exit_code_of(message.content) : null;
  const detail = exit_code === null ? size : `${size}, exit ${String(exit_code)}`;
  return `[volley] ${message.name} output (${detail}) elided from an earlier turn. Run it again if you need it.`;
}

/**
 * The request with every tool result before `cutoff` that is long enough to
 * matter and didn't fail replaced by a stub. Every message keeps its place,
 * role, id, and name. A stub reads only what comes before `cutoff`, so the
 * same transcript prefix always gives the same bytes.
 */
export function trim_view(messages: ReadonlyArray<Message>, cutoff: number): Message[] {
  const window = messages.slice(0, cutoff);
  const inputs = call_inputs(window);
  // Walk back from the boundary so each read meets the nearest later call on
  // its path.
  const next_on_path = new Map<string, Supersession>();
  const later_for = new Map<number, Supersession>();
  for (let i = window.length - 1; i >= 0; i -= 1) {
    const message = window[i];
    if (message?.role !== 'tool') continue;
    const input = inputs.get(message.tool_call_id);
    const path = input?.path ?? null;
    if (path === null) continue;
    if (message.name === 'read_file') {
      const later = next_on_path.get(path);
      if (later !== undefined) later_for.set(i, later);
    }
    const supersedes = supersession_of(message, input);
    if (supersedes !== null) next_on_path.set(path, supersedes);
  }
  return messages.map((message, i) => {
    if (i >= cutoff || message.role !== 'tool' || message.is_error === true) return message;
    if (message.content.length <= STUB_MIN_CHARS) return message;
    return { ...message, content: stub(message, inputs.get(message.tool_call_id), later_for.get(i)) };
  });
}

/**
 * Where to cut this turn's request, as a message index, or null to send it
 * whole. Boundaries are the starts of turns `TRIM_STRIDE_TURNS`,
 * `2 * TRIM_STRIDE_TURNS`, and so on, short of the last `TRIM_KEEP_TURNS`.
 * The cut moves to the next boundary only while the request, trimmed at the
 * last one, is still over `threshold`. A trimmed request only grows as the
 * session goes on, so a boundary once taken is kept.
 */
export function trim_cutoff(messages: ReadonlyArray<Message>, threshold: number): number | null {
  const turn_starts = messages.flatMap((message, i) => (message.role === 'assistant' ? [i] : []));
  let cutoff: number | null = null;
  for (let turn = TRIM_STRIDE_TURNS; turn <= turn_starts.length - TRIM_KEEP_TURNS; turn += TRIM_STRIDE_TURNS) {
    const view = cutoff === null ? messages : trim_view(messages, cutoff);
    if (estimate_tokens(view) <= threshold) break;
    cutoff = turn_starts[turn] ?? null;
  }
  return cutoff;
}

/** The `prepare_step` hook that trims a request estimated above `threshold`
 * tokens. */
export function step_trim(threshold: number): PrepareStepHook {
  return ({ messages }) => {
    const cutoff = trim_cutoff(messages, threshold);
    return cutoff === null ? undefined : { messages: trim_view(messages, cutoff) };
  };
}
