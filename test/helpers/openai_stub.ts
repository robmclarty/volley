/**
 * A stand-in OpenAI-compatible server, the shape OpenRouter speaks. It answers
 * `POST …/chat/completions` with one fixed assistant reply as SSE frames, the
 * way volley's model calls always ask, with usage on the last frame before
 * `[DONE]` as `stream_options.include_usage` asks, and `{}` to anything else,
 * such as the preflight's `GET` probe. Every request is recorded with the
 * headers a seat's attribution and auth ride on.
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
};

export type StubOpenAi = {
  /** The server's API root, `<origin>/v1`, the shape OpenRouter's has. */
  url: string;
  seen: SeenOpenAiRequest[];
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

function answer(
  reply: string,
  seen: SeenOpenAiRequest[],
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = (raw === '' ? {} : JSON.parse(raw)) as { model?: unknown; stream?: unknown };
      const model = typeof body.model === 'string' ? body.model : null;
      const path = req.url ?? '';
      seen.push({
        method: req.method ?? '',
        path,
        model,
        stream: body.stream === true,
        authorization: header(req, 'authorization'),
        x_title: header(req, 'x-title'),
      });
      if (req.method !== 'POST' || !path.endsWith('/chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        sse([
          { choices: [{ index: 0, delta: { role: 'assistant', content: reply } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          { choices: [], usage: USAGE },
        ]),
      );
    });
  };
}

/** Start a stub that answers every chat completion with `reply`. Stop it with
 * `close_servers`, from an `afterEach`. */
export async function stub_openai(reply: string): Promise<StubOpenAi> {
  const seen: SeenOpenAiRequest[] = [];
  const server = await start_server(answer(reply, seen));
  return { url: `${server.origin}/v1`, seen };
}
