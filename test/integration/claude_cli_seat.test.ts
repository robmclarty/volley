/**
 * What a `claude_cli` seat's subprocess actually gets: its environment under
 * each auth mode. Drives the real engine against the stand-in `claude`
 * binary, which records the env it was spawned with.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run_volley } from '../../src/orchestrator.js';
import { install_fake_claude } from '../helpers/fake_claude.js';
import type { FakeClaudeCall } from '../helpers/fake_claude.js';
import { silent_renderer, temp_git_workspace, test_config } from '../helpers/harness.js';

/** Run one all-Claude round on the fake under `auth_mode`, both seats' keys
 * set, and return each call the fake saw. */
async function claude_calls(auth_mode: string): Promise<FakeClaudeCall[]> {
  const { workspace, cleanup } = temp_git_workspace();
  const fake = install_fake_claude();
  try {
    vi.stubEnv('VOLLEY_CLAUDE_BIN', fake.bin);
    vi.stubEnv('VOLLEY_AUTH_MODE', auth_mode);
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-secret');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-secret');
    // Inherited only when the CLI gets the whole environment.
    vi.stubEnv('VOLLEY_TEST_INHERITED', 'yes');
    const result = await run_volley(test_config({ workspace }), {
      renderer: silent_renderer(),
      install_signal_handlers: false,
    });
    expect(result.status).toBe('success');
    const calls = fake.calls();
    expect(calls.map((call) => call.role)).toEqual(['builder', 'critic']);
    return calls;
  } finally {
    fake.remove();
    cleanup();
  }
}

describe('claude_cli seat env', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('under oauth, inherits the environment but neither seat key', async () => {
    for (const call of await claude_calls('oauth')) {
      expect(call.env['VOLLEY_TEST_INHERITED']).toBe('yes');
      expect(call.env).not.toHaveProperty('OPENROUTER_API_KEY');
      expect(call.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    }
  });

  it('under api_key, gets the Anthropic key and not the OpenRouter one', async () => {
    for (const call of await claude_calls('api_key')) {
      expect(call.env['ANTHROPIC_API_KEY']).toBe('sk-ant-secret');
      expect(call.env).not.toHaveProperty('OPENROUTER_API_KEY');
    }
  });

  it('under auto, gets neither key and leaves the CLI on its own login', async () => {
    for (const call of await claude_calls('auto')) {
      expect(call.env).not.toHaveProperty('OPENROUTER_API_KEY');
      expect(call.env).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(call.env).not.toHaveProperty('VOLLEY_TEST_INHERITED');
    }
  });
});
