import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUILDER_MODEL,
  DEFAULT_MAX_ITERATIONS,
  expand_at_file,
  load_config_file,
  resolve_config,
} from '../../src/config.js';
import { error_kind } from '../../src/types.js';
import { temp_workspace } from '../helpers/harness.js';

function base(workspace: string) {
  return { prompt: 'do it', workspace, criteria: 'it is done' };
}

describe('resolve_config', () => {
  it('applies defaults', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config(base(workspace));
      expect(config.builder_model).toBe(DEFAULT_BUILDER_MODEL);
      expect(config.critic_model).toBe('opus');
      expect(config.max_iterations).toBe(DEFAULT_MAX_ITERATIONS);
      expect(config.max_cost_usd).toBeNull();
      expect(config.check).toBe('auto');
      expect(config.critic_preset).toBe('reviewer');
      expect(config.builder_permission_mode).toBe('acceptEdits');
      expect(config.git_checkpoints).toBe(false);
      expect(config.show_thinking).toBe(true);
      expect(config.version).toBe(2);
      expect(config.run_id).toMatch(/[0-9a-f-]{36}/);
    } finally {
      cleanup();
    }
  });

  it('expands @file for prompt and criteria', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      writeFileSync(join(workspace, 'prompt.md'), 'the task\n');
      writeFileSync(join(workspace, 'criteria.md'), 'the criteria\n');
      const config = resolve_config({
        prompt: `@${join(workspace, 'prompt.md')}`,
        workspace,
        criteria: `@${join(workspace, 'criteria.md')}`,
      });
      expect(config.prompt).toBe('the task\n');
      expect(config.criteria).toBe('the criteria\n');
    } finally {
      cleanup();
    }
  });

  it('rejects missing required fields with config_error', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      for (const raw of [
        { workspace, criteria: 'x' },
        { prompt: 'x', criteria: 'x' },
        { prompt: 'x', workspace },
      ]) {
        try {
          resolve_config(raw as never);
          expect.unreachable('should have thrown');
        } catch (err) {
          expect(error_kind(err)).toBe('config_error');
        }
      }
    } finally {
      cleanup();
    }
  });

  it('rejects a nonexistent workspace', () => {
    expect(() => resolve_config(base('/nonexistent/volley/workspace'))).toThrow(
      /workspace not found/,
    );
  });

  it('rejects invalid max_iterations and max_cost_usd', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      expect(() => resolve_config({ ...base(workspace), max_iterations: 0 })).toThrow(
        /max-iterations/,
      );
      expect(() => resolve_config({ ...base(workspace), max_cost_usd: -1 })).toThrow(
        /max-cost-usd/,
      );
    } finally {
      cleanup();
    }
  });

  it('defaults critic_provider to claude_cli and accepts local providers', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      expect(resolve_config(base(workspace)).critic_provider).toBe('claude_cli');
      expect(
        resolve_config({ ...base(workspace), critic_provider: 'ollama' }).critic_provider,
      ).toBe('ollama');
      expect(
        resolve_config({ ...base(workspace), critic_provider: 'lmstudio' }).critic_provider,
      ).toBe('lmstudio');
    } finally {
      cleanup();
    }
  });

  it('rejects an unknown critic_provider', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      expect(() =>
        resolve_config({ ...base(workspace), critic_provider: 'openai' as never }),
      ).toThrow(/--critic-provider/);
    } finally {
      cleanup();
    }
  });

  it('rejects an unknown critic that is not a file', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      expect(() => resolve_config({ ...base(workspace), critic: 'nonsense' })).toThrow(
        /--critic/,
      );
    } finally {
      cleanup();
    }
  });

  it('resolves a custom critic prompt path', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const path = join(workspace, 'my-critic.md');
      writeFileSync(path, 'be harsh');
      const config = resolve_config({ ...base(workspace), critic: path });
      expect(config.critic_preset).toBe('custom');
      expect(config.critic_prompt_path).toBe(path);
    } finally {
      cleanup();
    }
  });

  it('rejects --git outside a git repository', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      expect(() => resolve_config({ ...base(workspace), git_checkpoints: true })).toThrow(
        /git repository/,
      );
      mkdirSync(join(workspace, '.git'));
      const config = resolve_config({ ...base(workspace), git_checkpoints: true });
      expect(config.git_checkpoints).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe('expand_at_file', () => {
  it('passes plain strings through', () => {
    expect(expand_at_file('just text', '/tmp')).toBe('just text');
  });

  it('throws config_error for a missing file', () => {
    try {
      expand_at_file('@/nope/missing.md', '/tmp');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(error_kind(err)).toBe('config_error');
    }
  });
});

describe('load_config_file', () => {
  it('loads a TypeScript config default export', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const path = join(workspace, 'volley.config.ts');
      writeFileSync(
        path,
        `const config = { prompt: 'from file', workspace: '.', criteria: 'ok', max_iterations: 3 };\nexport default config;\n`,
      );
      const loaded = await load_config_file(path);
      expect(loaded.prompt).toBe('from file');
      expect(loaded.max_iterations).toBe(3);
    } finally {
      cleanup();
    }
  });

  it('throws config_error for a missing config file', async () => {
    await expect(load_config_file('/nope/volley.config.ts')).rejects.toMatchObject({
      kind: 'config_error',
    });
  });
});
