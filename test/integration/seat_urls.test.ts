/**
 * Per-seat model URLs, end to end. The real engines and the real ai-sdk-ollama
 * client run against two stand-in Ollama servers, one per seat, so every request
 * a seat makes can be traced to the server it reached: the model calls, the
 * prewarm, the context probe, the preflight probe, and the critic canary.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve_config } from '../../src/config.js';
import { EXIT_SUCCESS } from '../../src/exit_codes.js';
import { run_volley } from '../../src/orchestrator.js';
import { preflight } from '../../src/preflight.js';
import type { VolleyConfig } from '../../src/types.js';
import { silent_renderer, temp_workspace } from '../helpers/harness.js';
import { close_servers, start_server } from '../helpers/http_server.js';

/** The test file's own state root (`test/setup.ts`), which an explicit env
 * would otherwise hide, sending each run's state to the real home. */
const ENV = { XDG_STATE_HOME: process.env['XDG_STATE_HOME'] };

type SeenRequest = { method: string; path: string; model: string | null };
type StubOllama = { url: string; seen: SeenRequest[] };

const APPROVED = JSON.stringify({
  verdict: 'approved',
  feedback: 'Looks good.',
  unmet_criteria: [],
});

/** Answer the way Ollama does: a chat as one final frame carrying `reply`
 * (NDJSON when the client streams), and `{}` for everything else volley asks
 * (the prewarm's `/api/generate`, the context probe's `/api/show`, and the
 * preflight's `GET /`). */
function answer(
  reply: string,
  seen: SeenRequest[],
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
      seen.push({ method: req.method ?? '', path: req.url ?? '', model });
      if (req.url !== '/api/chat') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      const frame = {
        model,
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content: reply },
        done: true,
        done_reason: 'stop',
        total_duration: 2_000_000,
        load_duration: 0,
        prompt_eval_count: 10,
        prompt_eval_duration: 1_000_000,
        eval_count: 5,
        eval_duration: 1_000_000,
      };
      const streamed = body.stream === true;
      res.writeHead(200, {
        'content-type': streamed ? 'application/x-ndjson' : 'application/json',
      });
      res.end(streamed ? `${JSON.stringify(frame)}\n` : JSON.stringify(frame));
    });
  };
}

async function stub_ollama(reply: string): Promise<StubOllama> {
  const seen: SeenRequest[] = [];
  const server = await start_server(answer(reply, seen));
  return { url: server.origin, seen };
}

function requests(stub: StubOllama): string[] {
  return stub.seen.map(({ method, path }) => `${method} ${path}`);
}

function models(stub: StubOllama): Set<string | null> {
  return new Set(stub.seen.filter(({ path }) => path !== '/').map(({ model }) => model));
}

/** Both seats on Ollama, uncontained by explicit opt-out, one iteration with no
 * check, so a single approving verdict ends the run. */
function ollama_seats(workspace: string, urls: Partial<VolleyConfig> = {}): VolleyConfig {
  return {
    prompt: 'write the file',
    workspace,
    criteria: 'the file exists',
    check: 'none',
    max_iterations: 1,
    builder_provider: 'ollama',
    builder_model: 'builder-model',
    critic_provider: 'ollama',
    critic_model: 'critic-model',
    allow_unsandboxed_builder: true,
    ...urls,
  };
}

beforeEach(() => {
  // The run reads the engine's environment from the process. Pin everything
  // that could re-point or reprice it, so the developer's shell can't.
  vi.stubEnv('VOLLEY_MODEL_HOST', '');
  vi.stubEnv('VOLLEY_PRICING_PATH', '');
  vi.stubEnv('VOLLEY_AUTH_MODE', 'auto');
  vi.stubEnv('VOLLEY_OLLAMA_URL', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await close_servers();
});

describe('per-seat model URLs, against two stand-in Ollama servers', () => {
  it("sends each seat's model calls, prewarm, and context probe to its own server", async () => {
    const builder_server = await stub_ollama('done');
    const critic_server = await stub_ollama(APPROVED);
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config(
        ollama_seats(workspace, {
          builder_url: builder_server.url,
          critic_url: critic_server.url,
        }),
        { env: ENV },
      );
      const result = await run_volley(config, {
        renderer: silent_renderer(),
        install_signal_handlers: false,
      });

      expect(result.status).toBe('success');
      expect(requests(builder_server)).toEqual(
        expect.arrayContaining(['POST /api/show', 'POST /api/generate', 'POST /api/chat']),
      );
      expect(models(builder_server)).toEqual(new Set(['builder-model']));
      expect(requests(critic_server)).toEqual(
        expect.arrayContaining(['POST /api/generate', 'POST /api/chat']),
      );
      expect(requests(critic_server)).not.toContain('POST /api/show');
      expect(models(critic_server)).toEqual(new Set(['critic-model']));
    } finally {
      cleanup();
    }
  });

  it('sends both seats to the env var server when neither names a URL', async () => {
    const shared_server = await stub_ollama(APPROVED);
    const unused_server = await stub_ollama(APPROVED);
    vi.stubEnv('VOLLEY_OLLAMA_URL', shared_server.url);
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config(ollama_seats(workspace), { env: ENV });
      const result = await run_volley(config, {
        renderer: silent_renderer(),
        install_signal_handlers: false,
      });

      expect(result.status).toBe('success');
      expect(models(shared_server)).toEqual(new Set(['builder-model', 'critic-model']));
      expect(unused_server.seen).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("probes each seat's own server in --dry-run, and canaries the critic on its own", async () => {
    const builder_server = await stub_ollama('done');
    const critic_server = await stub_ollama(APPROVED);
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config(
        ollama_seats(workspace, {
          builder_url: builder_server.url,
          critic_url: critic_server.url,
        }),
        { env: ENV },
      );
      const code = await preflight(config, silent_renderer(), {}, {
        toolchain_missing: () => [],
        checkride_doctor: () => true,
      });

      expect(code).toBe(EXIT_SUCCESS);
      expect(requests(builder_server)).toEqual(['GET /']);
      expect(requests(critic_server)[0]).toBe('GET /');
      expect(requests(critic_server)).toEqual(
        expect.arrayContaining(['POST /api/generate', 'POST /api/chat']),
      );
      expect(models(critic_server)).toEqual(new Set(['critic-model']));
    } finally {
      cleanup();
    }
  });
});
