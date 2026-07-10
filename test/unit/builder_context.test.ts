import { describe, expect, it } from 'vitest';
import {
  MIN_RECOMMENDED_NUM_CTX,
  context_warning,
  parse_num_ctx,
} from '../../src/builder/context_check.js';

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
