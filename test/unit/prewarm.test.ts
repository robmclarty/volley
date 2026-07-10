import { afterEach, describe, expect, it, vi } from 'vitest';
import { prewarm_ollama_model } from '../../src/prewarm.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('prewarm_ollama_model', () => {
  it('posts the model to /api/generate at the server root (trailing slash stripped)', async () => {
    const fetch_stub = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetch_stub);

    await prewarm_ollama_model('http://localhost:11434/', 'qwen3.6:latest');

    expect(fetch_stub).toHaveBeenCalledTimes(1);
    const [url, init] = fetch_stub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/api/generate');
    expect(init.method).toBe('POST');
    // No prompt: Ollama's documented load-only call.
    expect(JSON.parse(init.body as string)).toEqual({ model: 'qwen3.6:latest' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('never throws: a failed request (server down) resolves silently', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(prewarm_ollama_model('http://localhost:11434', 'm')).resolves.toBeUndefined();
  });

  it('never throws: an already-aborted run signal resolves silently', async () => {
    // Real fetch rejects immediately on an aborted signal; mirror that.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        (init.signal as AbortSignal).throwIfAborted();
        return Promise.resolve(new Response('{}'));
      }),
    );
    await expect(
      prewarm_ollama_model('http://localhost:11434', 'm', AbortSignal.abort()),
    ).resolves.toBeUndefined();
  });
});
