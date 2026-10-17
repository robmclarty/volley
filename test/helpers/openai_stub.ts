/**
 * A stand-in OpenAI-compatible server, the shape OpenRouter speaks. It answers
 * each `POST …/chat/completions` with the next turn of its script as SSE
 * frames, the way volley's model calls always ask, with usage on the last
 * frame before `[DONE]` as `stream_options.include_usage` asks, and `{}` to
 * anything else, such as the preflight's `GET` probe. A turn is text, a tool
 * call, or both, and the last turn answers every completion past the end of
 * the script. Every request is recorded with the headers a seat's
 * attribution and auth ride on, and the messages it sent.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { start_server } from './http_server.js';

export type SeenOpenAiRequest = {
  method: string;
  path: string;
  model: string | null;
  /** Whether the client asked for SSE frames. */
  stream: boolean;
  authorization: string | null;
  x_title: string | null;
  /** The request's `messages`, as sent: what the model read. */
  messages: unknown[];
};

export type StubOpenAi = {
  /** The server's API root, `<origin>/v1`, the shape OpenRouter's has. */
  url: string;
  seen: SeenOpenAiRequest[];
};

/** One scripted reply: text the model streams, then a tool call it makes. */
export type StubTurn = {
  text?: string;
  tool_call?: { id: string; name: string; input: unknown };
};

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return typeof value === 'string' ? value : null;
}

function sse(frames: ReadonlyArray<unknown>): string {
  return [...frames.map((frame) => JSON.stringify(frame)), '[DONE]']
    .map((data) => `data: ${data}\n\n`)
    .join('');
}

/** A turn's frames: its text, its tool call with the arguments whole in one
 * delta, the finish reason that closes the call, then usage. */
function turn_frames(turn: StubTurn): unknown[] {
  const deltas: unknown[] = [];
  if (turn.text !== undefined) deltas.push({ role: 'assistant', content: turn.text });
  const call = turn.tool_call;
  if (call !== undefined) {
    deltas.push({
      tool_calls: [
        {
          index: 0,
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        },
      ],
    });
  }
  return [
    ...deltas.map((delta) => ({ choices: [{ index: 0, delta }] })),
    { choices: [{ index: 0, delta: {}, finish_reason: call === undefined ? 'stop' : 'tool_calls' }] },
    { choices: [], usage: USAGE },
  ];
}

function answer(
  script: ReadonlyArray<StubTurn>,
  seen: SeenOpenAiRequest[],
): (req: IncomingMessage, res: ServerResponse) => void {
  let completions = 0;
  return (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = (raw === '' ? {} : JSON.parse(raw)) as {
        model?: unknown;
        stream?: unknown;
        messages?: unknown;
      };
      const model = typeof body.model === 'string' ? body.model : null;
      const path = req.url ?? '';
      seen.push({
        method: req.method ?? '',
        path,
        model,
        stream: body.stream === true,
        authorization: header(req, 'authorization'),
        x_title: header(req, 'x-title'),
        messages: Array.isArray(body.messages) ? body.messages : [],
      });
      if (req.method !== 'POST' || !path.endsWith('/chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      const turn = script[Math.min(completions, script.length - 1)] ?? {};
      completions += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse(turn_frames(turn)));
    });
  };
}

/** Start a stub that answers its chat completions with `script`'s turns in
 * order, or every one with `reply` when given text. Stop it with
 * `close_servers`, from an `afterEach`. */
export async function stub_openai(reply: string | ReadonlyArray<StubTurn>): Promise<StubOpenAi> {
  const seen: SeenOpenAiRequest[] = [];
  const script = typeof reply === 'string' ? [{ text: reply }] : reply;
  const server = await start_server(answer(script, seen));
  return { url: `${server.origin}/v1`, seen };
}
