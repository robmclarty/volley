import { describe, expect, it } from 'vitest';
import {
  cross_to_host_gateway,
  DEFAULT_LMSTUDIO_URL,
  DEFAULT_OLLAMA_URL,
  seat_base_url,
  SEAT_URL_PROVIDERS,
  takes_seat_url,
} from '../../src/engine.js';

describe('seat_base_url — ollama', () => {
  it('defaults to the server root — NOT …/api, which ai-sdk-ollama appends itself', () => {
    expect(seat_base_url('ollama', null, {})).toBe('http://localhost:11434');
    expect(DEFAULT_OLLAMA_URL).toBe('http://localhost:11434');
  });

  it('passes a server-root env override through unchanged', () => {
    expect(seat_base_url('ollama', null, { VOLLEY_OLLAMA_URL: 'http://gpu-box:11434' })).toBe(
      'http://gpu-box:11434',
    );
  });

  it('normalizes a trailing /api (the pre-v0.3.1 documented default) and trailing slashes', () => {
    expect(seat_base_url('ollama', null, { VOLLEY_OLLAMA_URL: 'http://localhost:11434/api' })).toBe(
      'http://localhost:11434',
    );
    expect(seat_base_url('ollama', null, { VOLLEY_OLLAMA_URL: 'http://localhost:11434/api/' })).toBe(
      'http://localhost:11434',
    );
    expect(seat_base_url('ollama', null, { VOLLEY_OLLAMA_URL: 'http://localhost:11434/' })).toBe(
      'http://localhost:11434',
    );
    expect(seat_base_url('ollama', 'http://gpu-box:11434/api/', {})).toBe('http://gpu-box:11434');
  });

  it('crosses a loopback URL to VOLLEY_MODEL_HOST when volley runs contained', () => {
    // In-container: the host LLM daemon is reached across the boundary; the
    // server-root shape (no trailing slash) is preserved after the swap.
    expect(
      seat_base_url('ollama', null, {
        VOLLEY_OLLAMA_URL: 'http://localhost:11434',
        VOLLEY_MODEL_HOST: 'host.docker.internal',
      }),
    ).toBe('http://host.docker.internal:11434');
    // The default loopback URL crosses too, even when only the override is set.
    expect(seat_base_url('ollama', null, { VOLLEY_MODEL_HOST: 'host.docker.internal' })).toBe(
      'http://host.docker.internal:11434',
    );
  });
});

describe('seat_base_url — a seat of its own', () => {
  const ENV = {
    VOLLEY_OLLAMA_URL: 'http://shared-box:11434',
    VOLLEY_LMSTUDIO_URL: 'http://shared-box:1234/v1',
  };

  it("prefers the seat's own URL over the provider's env var", () => {
    expect(seat_base_url('ollama', 'http://localhost:11522', ENV)).toBe('http://localhost:11522');
    expect(seat_base_url('lmstudio', 'http://localhost:1235/v1', ENV)).toBe(
      'http://localhost:1235/v1',
    );
  });

  it('falls back to the env var, then the default — never to the other seat', () => {
    expect(seat_base_url('ollama', null, ENV)).toBe('http://shared-box:11434');
    expect(seat_base_url('lmstudio', null, ENV)).toBe('http://shared-box:1234/v1');
    expect(seat_base_url('lmstudio', null, {})).toBe(DEFAULT_LMSTUDIO_URL);
  });

  it('treats an empty or blank value as unset, at every level', () => {
    expect(seat_base_url('ollama', '', ENV)).toBe('http://shared-box:11434');
    expect(seat_base_url('ollama', '   ', ENV)).toBe('http://shared-box:11434');
    expect(seat_base_url('ollama', null, { VOLLEY_OLLAMA_URL: '' })).toBe(DEFAULT_OLLAMA_URL);
    expect(seat_base_url('lmstudio', '', { VOLLEY_LMSTUDIO_URL: ' ' })).toBe(DEFAULT_LMSTUDIO_URL);
  });

  it("keeps LM Studio's /v1 path and strips only its trailing slashes", () => {
    expect(seat_base_url('lmstudio', 'http://localhost:1235/v1/', {})).toBe(
      'http://localhost:1235/v1',
    );
    // `/api` is an Ollama spelling only; LM Studio's path is left as given.
    expect(seat_base_url('lmstudio', 'http://localhost:1235/api', {})).toBe(
      'http://localhost:1235/api',
    );
  });

  it('crosses two loopback seats on different ports, each on its own port', () => {
    const contained = { VOLLEY_MODEL_HOST: 'host.docker.internal' };
    expect(seat_base_url('ollama', 'http://localhost:11522', contained)).toBe(
      'http://host.docker.internal:11522',
    );
    expect(seat_base_url('ollama', 'http://127.0.0.1:11523', contained)).toBe(
      'http://host.docker.internal:11523',
    );
    // A seat on a real remote machine is left as given.
    expect(seat_base_url('ollama', 'http://gpu-box:11434', contained)).toBe('http://gpu-box:11434');
  });
});

describe('takes_seat_url', () => {
  it('is true only for the providers volley reaches at a base URL', () => {
    expect(takes_seat_url('ollama')).toBe(true);
    expect(takes_seat_url('lmstudio')).toBe(true);
    expect(takes_seat_url('claude_cli')).toBe(false);
    expect(takes_seat_url(undefined)).toBe(false);
    expect(SEAT_URL_PROVIDERS).toEqual(['ollama', 'lmstudio']);
  });
});

describe('cross_to_host_gateway (container→host crossing)', () => {
  const CROSS = { VOLLEY_MODEL_HOST: 'host.docker.internal' };

  it('is a no-op when the override is unset (the host / unsandboxed path)', () => {
    expect(cross_to_host_gateway('http://localhost:11434', {})).toBe('http://localhost:11434');
    expect(cross_to_host_gateway('http://localhost:11434', { VOLLEY_MODEL_HOST: '' })).toBe(
      'http://localhost:11434',
    );
  });

  it('swaps only a loopback host, preserving port and path', () => {
    expect(cross_to_host_gateway('http://127.0.0.1:11434', CROSS)).toBe(
      'http://host.docker.internal:11434',
    );
    // LM Studio's `/v1` path survives the crossing.
    expect(cross_to_host_gateway('http://localhost:1234/v1', CROSS)).toBe(
      'http://host.docker.internal:1234/v1',
    );
  });

  it('crosses the IPv6 loopback, whose hostname URL keeps in brackets', () => {
    expect(cross_to_host_gateway('http://[::1]:11522', CROSS)).toBe(
      'http://host.docker.internal:11522',
    );
  });

  it('leaves a real remote daemon untouched (only loopback is crossed)', () => {
    expect(cross_to_host_gateway('http://gpu-box:11434', CROSS)).toBe('http://gpu-box:11434');
  });

  it('leaves an unparseable URL untouched', () => {
    expect(cross_to_host_gateway('not a url', CROSS)).toBe('not a url');
  });
});
