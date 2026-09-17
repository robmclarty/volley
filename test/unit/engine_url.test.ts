import { describe, expect, it } from 'vitest';
import {
  cross_to_host_gateway,
  DEFAULT_OLLAMA_URL,
  resolve_ollama_base_url,
} from '../../src/engine.js';

describe('resolve_ollama_base_url', () => {
  it('defaults to the server root — NOT …/api, which ai-sdk-ollama appends itself', () => {
    expect(resolve_ollama_base_url({})).toBe('http://localhost:11434');
    expect(DEFAULT_OLLAMA_URL).toBe('http://localhost:11434');
  });

  it('passes a server-root override through unchanged', () => {
    expect(resolve_ollama_base_url({ VOLLEY_OLLAMA_URL: 'http://gpu-box:11434' })).toBe(
      'http://gpu-box:11434',
    );
  });

  it('normalizes a trailing /api (the pre-v0.3.1 documented default) and trailing slashes', () => {
    expect(resolve_ollama_base_url({ VOLLEY_OLLAMA_URL: 'http://localhost:11434/api' })).toBe(
      'http://localhost:11434',
    );
    expect(resolve_ollama_base_url({ VOLLEY_OLLAMA_URL: 'http://localhost:11434/api/' })).toBe(
      'http://localhost:11434',
    );
    expect(resolve_ollama_base_url({ VOLLEY_OLLAMA_URL: 'http://localhost:11434/' })).toBe(
      'http://localhost:11434',
    );
  });

  it('crosses a loopback URL to VOLLEY_MODEL_HOST when volley runs contained', () => {
    // In-container: the host LLM daemon is reached across the boundary; the
    // server-root shape (no trailing slash) is preserved after the swap.
    expect(
      resolve_ollama_base_url({
        VOLLEY_OLLAMA_URL: 'http://localhost:11434',
        VOLLEY_MODEL_HOST: 'host.docker.internal',
      }),
    ).toBe('http://host.docker.internal:11434');
    // The default loopback URL crosses too, even when only the override is set.
    expect(resolve_ollama_base_url({ VOLLEY_MODEL_HOST: 'host.docker.internal' })).toBe(
      'http://host.docker.internal:11434',
    );
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

  it('leaves a real remote daemon untouched (only loopback is crossed)', () => {
    expect(cross_to_host_gateway('http://gpu-box:11434', CROSS)).toBe('http://gpu-box:11434');
  });

  it('leaves an unparseable URL untouched', () => {
    expect(cross_to_host_gateway('not a url', CROSS)).toBe('not a url');
  });
});
