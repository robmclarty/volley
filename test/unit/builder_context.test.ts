import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MIN_RECOMMENDED_NUM_CTX,
  context_warning,
  parse_num_ctx,
  probe_ollama_num_ctx,
} from '../../src/builder/context_check.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parse_num_ctx', () => {
  it('reads num_ctx from an Ollama parameters blob', () => {
    expect(parse_num_ctx('num_ctx 4096')).toBe(4096);
    // Real /api/show parameters are multi-line and whitespace-padded.
    expect(parse_num_ctx('stop "<|im_end|>"\nnum_ctx                    16384\ntemperature 0.7')).toBe(
      16384,
    );
  });

  it('returns null when num_ctx is absent, unparseable, or the blob is null', () => {
    // The common case: a server on its own default sets no num_ctx parameter,
    // which is exactly the "not detectable" edge — no false-positive warning.
    expect(parse_num_ctx('stop "<|im_end|>"\ntemperature 0.7')).toBeNull();
    expect(parse_num_ctx('num_ctx notanumber')).toBeNull();
    expect(parse_num_ctx(null)).toBeNull();
  });
});

describe('probe_ollama_num_ctx', () => {
  it('POSTs the model to /api/show at the server root and parses num_ctx', async () => {
    const fetch_stub = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ parameters: 'num_ctx 8192' })));
    vi.stubGlobal('fetch', fetch_stub);

    // base_url is the server root (resolve_ollama_base_url output), so the
    // probe supplies the /api prefix itself.
    await expect(probe_ollama_num_ctx('http://localhost:11434', 'm')).resolves.toBe(8192);
    const [url] = fetch_stub.mock.calls[0] as [string];
    expect(url).toBe('http://localhost:11434/api/show');
  });

  it('returns null on any failure — probe never gates the builder', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(probe_ollama_num_ctx('http://localhost:11434', 'm')).resolves.toBeNull();
  });
});

describe('context_warning', () => {
  it('warns when a detected window is below the recommended floor', () => {
    const warning = context_warning('qwen3-coder:30b', 4096);
    expect(warning).not.toBeNull();
    expect(warning).toContain('qwen3-coder:30b');
    expect(warning).toContain('4096');
    expect(warning).toContain('num_ctx');
  });

  it('stays silent at or above the floor, and when the value is undetectable', () => {
    expect(context_warning('m', MIN_RECOMMENDED_NUM_CTX)).toBeNull();
    expect(context_warning('m', MIN_RECOMMENDED_NUM_CTX + 1)).toBeNull();
    // null = not detectable (server default): warn only where detectable.
    expect(context_warning('m', null)).toBeNull();
  });
});
