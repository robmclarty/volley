import { describe, expect, it } from 'vitest';
import { DEFAULT_OLLAMA_URL, resolve_ollama_base_url } from '../../src/engine.js';

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
});
