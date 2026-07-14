import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUILDER_MAX_STEPS,
  DEFAULT_BUILDER_MODEL,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_SANDBOX_IMAGE,
  expand_at_file,
  load_config_file,
  resolve_config,
} from '../../src/config.js';
import { warn_unsandboxed_builder } from '../../src/cli.js';
import { load_resume_state } from '../../src/iteration.js';
import { error_kind } from '../../src/types.js';
import { create_renderer } from '../../src/render/renderer.js';
import { initialize_workspace, write_resolved_config } from '../../src/workspace.js';
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
      expect(config.builder_provider).toBe('claude_cli');
      expect(config.builder_max_steps).toBe(DEFAULT_BUILDER_MAX_STEPS);
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

  it('defaults builder_provider to claude_cli and accepts local providers (with opt-out)', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      expect(resolve_config(base(workspace)).builder_provider).toBe('claude_cli');
      // Local providers are refused without the D11 opt-out (covered separately);
      // here they resolve once it is granted.
      expect(
        resolve_config({
          ...base(workspace),
          builder_provider: 'ollama',
          allow_unsandboxed_builder: true,
        }).builder_provider,
      ).toBe('ollama');
      expect(
        resolve_config({
          ...base(workspace),
          builder_provider: 'lmstudio',
          allow_unsandboxed_builder: true,
        }).builder_provider,
      ).toBe('lmstudio');
    } finally {
      cleanup();
    }
  });

  it('rejects an unknown builder_provider', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      expect(() =>
        resolve_config({ ...base(workspace), builder_provider: 'openai' as never }),
      ).toThrow(/--builder-provider/);
    } finally {
      cleanup();
    }
  });

  it('refuses a local builder with no opt-out (D11) — before any model spend', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      for (const provider of ['ollama', 'lmstudio'] as const) {
        try {
          // resolve_config runs before any model spend and before the --dry-run
          // branch, so this same throw is what refuses `--dry-run` too.
          resolve_config({ ...base(workspace), builder_provider: provider }, { env: {} });
          expect.unreachable('should have refused the unsandboxed local builder');
        } catch (err) {
          expect(error_kind(err)).toBe('config_error');
          expect((err as Error).message).toMatch(/allow-unsandboxed-builder/);
        }
      }
    } finally {
      cleanup();
    }
  });

  it('claude_cli needs no opt-out and defaults allow_unsandboxed_builder to false', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config(base(workspace), { env: {} });
      expect(config.builder_provider).toBe('claude_cli');
      expect(config.allow_unsandboxed_builder).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('the --allow-unsandboxed-builder flag lets a local builder resolve', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config(
        { ...base(workspace), builder_provider: 'ollama', allow_unsandboxed_builder: true },
        { env: {} },
      );
      expect(config.builder_provider).toBe('ollama');
      expect(config.allow_unsandboxed_builder).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('VOLLEY_ALLOW_UNSANDBOXED_BUILDER=1 (or =true) opts out; other values do not', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      for (const value of ['1', 'true']) {
        const config = resolve_config(
          { ...base(workspace), builder_provider: 'lmstudio' },
          { env: { VOLLEY_ALLOW_UNSANDBOXED_BUILDER: value } },
        );
        expect(config.allow_unsandboxed_builder).toBe(true);
      }
      for (const value of ['0', 'false', '']) {
        expect(() =>
          resolve_config(
            { ...base(workspace), builder_provider: 'lmstudio' },
            { env: { VOLLEY_ALLOW_UNSANDBOXED_BUILDER: value } },
          ),
        ).toThrow(/allow-unsandboxed-builder/);
      }
    } finally {
      cleanup();
    }
  });

  it('defaults builder_max_steps to 50', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      expect(DEFAULT_BUILDER_MAX_STEPS).toBe(50);
      expect(resolve_config(base(workspace), { env: {} }).builder_max_steps).toBe(50);
    } finally {
      cleanup();
    }
  });

  it('reads builder_max_steps from VOLLEY_BUILDER_MAX_STEPS', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config(base(workspace), {
        env: { VOLLEY_BUILDER_MAX_STEPS: '12' },
      });
      expect(config.builder_max_steps).toBe(12);
    } finally {
      cleanup();
    }
  });

  it('prefers the --builder-max-steps flag over the env var (flag > env > default)', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config(
        { ...base(workspace), builder_max_steps: 7 },
        { env: { VOLLEY_BUILDER_MAX_STEPS: '12' } },
      );
      expect(config.builder_max_steps).toBe(7);
    } finally {
      cleanup();
    }
  });

  it('rejects a non-positive-integer builder_max_steps from flag or env', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      for (const bad of [0, -1, 2.5]) {
        expect(() =>
          resolve_config({ ...base(workspace), builder_max_steps: bad }, { env: {} }),
        ).toThrow(/builder-max-steps/);
      }
      for (const bad of ['0', '-3', '1.5', 'abc']) {
        expect(() =>
          resolve_config(base(workspace), { env: { VOLLEY_BUILDER_MAX_STEPS: bad } }),
        ).toThrow(/builder-max-steps/i);
      }
    } finally {
      cleanup();
    }
  });

  it('preserves builder_max_steps across a persist→restore round-trip', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      initialize_workspace(workspace);
      const original = resolve_config(
        { ...base(workspace), builder_max_steps: 7 },
        { run_id: 'rt-run', env: {} },
      );
      write_resolved_config(original);
      const resume = load_resume_state(workspace, 'rt-run');
      expect(resume.raw_config.builder_max_steps).toBe(7);
      const restored = resolve_config(resume.raw_config, {
        run_id: resume.run_id,
        started_at: resume.started_at,
        env: {},
      });
      expect(restored.builder_max_steps).toBe(7);
    } finally {
      cleanup();
    }
  });

  it('defaults builder_max_steps when restoring a config that predates the field', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      initialize_workspace(workspace);
      const original = resolve_config(base(workspace), { run_id: 'old-run', env: {} });
      write_resolved_config(original);
      const config_path = join(workspace, '.volley', 'config.json');
      const record = JSON.parse(readFileSync(config_path, 'utf8')) as Record<string, unknown>;
      delete record['builder_max_steps'];
      writeFileSync(config_path, `${JSON.stringify(record, null, 2)}\n`);

      const resume = load_resume_state(workspace, 'old-run');
      expect(resume.raw_config.builder_max_steps).toBeUndefined();
      const restored = resolve_config(resume.raw_config, { run_id: resume.run_id, env: {} });
      expect(restored.builder_max_steps).toBe(DEFAULT_BUILDER_MAX_STEPS);
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

  it('defaults --worktree off and rejects it outside a git repository', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      expect(resolve_config(base(workspace)).worktree).toBe(false);
      expect(() => resolve_config({ ...base(workspace), worktree: true })).toThrow(
        /git repository/,
      );
      mkdirSync(join(workspace, '.git'));
      const config = resolve_config({ ...base(workspace), worktree: true });
      expect(config.worktree).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('defaults the sandbox image to volley-sandbox:latest', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      expect(DEFAULT_SANDBOX_IMAGE).toBe('volley-sandbox:latest');
      expect(resolve_config(base(workspace), { env: {} }).sandbox_image).toBe(
        DEFAULT_SANDBOX_IMAGE,
      );
    } finally {
      cleanup();
    }
  });

  it('reads the sandbox image from VOLLEY_SANDBOX_IMAGE', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config(base(workspace), {
        env: { VOLLEY_SANDBOX_IMAGE: 'my-org/sandbox:9' },
      });
      expect(config.sandbox_image).toBe('my-org/sandbox:9');
    } finally {
      cleanup();
    }
  });

  it('prefers the --sandbox-image flag over the env var (flag > env > default)', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config(
        { ...base(workspace), sandbox_image: 'flag/img:1' },
        { env: { VOLLEY_SANDBOX_IMAGE: 'env/img:2' } },
      );
      expect(config.sandbox_image).toBe('flag/img:1');
    } finally {
      cleanup();
    }
  });

  it('preserves the sandbox image across a persist→restore round-trip', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      initialize_workspace(workspace);
      const original = resolve_config(
        { ...base(workspace), sandbox_image: 'pinned/img:3' },
        { run_id: 'si-run', env: {} },
      );
      write_resolved_config(original);
      const resume = load_resume_state(workspace, 'si-run');
      expect(resume.raw_config.sandbox_image).toBe('pinned/img:3');
      const restored = resolve_config(resume.raw_config, {
        run_id: resume.run_id,
        started_at: resume.started_at,
        env: {},
      });
      expect(restored.sandbox_image).toBe('pinned/img:3');
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

describe('warn_unsandboxed_builder', () => {
  function capture(config: Parameters<typeof warn_unsandboxed_builder>[0]) {
    const out: string[] = [];
    const renderer = create_renderer({
      mode: 'default',
      show_thinking: true,
      color: false,
      max_cost_usd: null,
      write: (text) => out.push(text),
    });
    warn_unsandboxed_builder(config, renderer);
    return out.join('');
  }

  it('emits one loud warning when an opted-in local builder proceeds', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config(
        { ...base(workspace), builder_provider: 'ollama', allow_unsandboxed_builder: true },
        { env: {} },
      );
      const output = capture(config);
      expect(output).toMatch(/unsandboxed/i);
      expect(output.match(/warning:/g)).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('stays silent for the sandboxed default (claude_cli) builder', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config(base(workspace), { env: {} });
      expect(capture(config)).toBe('');
    } finally {
      cleanup();
    }
  });
});
