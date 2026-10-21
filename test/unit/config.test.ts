import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUILDER_MAX_STEPS,
  DEFAULT_BUILDER_MODEL,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_SANDBOX_IMAGE,
  detect_containment,
  expand_at_file,
  load_config_file,
  resolve_config,
  unguarded_builder,
} from '../../src/config.js';
import { DEFAULT_GATE_PATTERNS } from '../../src/changes.js';
import { package_version, warn_unsandboxed_builder } from '../../src/cli.js';
import { load_resume_state } from '../../src/iteration.js';
import { error_kind } from '../../src/types.js';
import { create_renderer } from '../../src/render/renderer.js';
import { initialize_run_state, write_resolved_config } from '../../src/workspace.js';
import { temp_workspace } from '../helpers/harness.js';

function base(workspace: string) {
  return { prompt: 'do it', workspace, criteria: 'it is done' };
}

/** Both seats on Ollama, for the per-seat URL tests. */
function local_seats(workspace: string) {
  return {
    ...base(workspace),
    builder_provider: 'ollama' as const,
    critic_provider: 'ollama' as const,
  };
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
      // Local providers are refused without the opt-out (covered separately);
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

  it('refuses a local builder with no opt-out — before any model spend', () => {
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

  it('a contained local builder resolves without the opt-out', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      for (const provider of ['ollama', 'lmstudio'] as const) {
        // A fully-local contained run: local critic too, so the claude_cli
        // containment auth gate does not apply here.
        const config = resolve_config(
          { ...base(workspace), builder_provider: provider, critic_provider: provider },
          { env: { VOLLEY_CONTAINED: '1' } },
        );
        expect(config.builder_provider).toBe(provider);
        // Containment is not the host opt-out — the flag stays false.
        expect(config.allow_unsandboxed_builder).toBe(false);
      }
    } finally {
      cleanup();
    }
  });

  it('an uncontained local builder is still refused without the opt-out', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      // Falsy containment markers do not open the gate; only the opt-out or a
      // real container does.
      for (const value of ['0', 'false', '']) {
        expect(() =>
          resolve_config(
            { ...base(workspace), builder_provider: 'ollama' },
            { env: { VOLLEY_CONTAINED: value } },
          ),
        ).toThrow(/refused unless contained/);
      }
    } finally {
      cleanup();
    }
  });

  it('refuses a contained claude_cli role unless it uses api_key auth (OAuth is mangled in a container)', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      // Contained claude_cli builder without an explicit api_key mode.
      for (const auth of [undefined, 'auto', 'oauth']) {
        expect(() =>
          resolve_config(
            { ...base(workspace) },
            { env: { VOLLEY_CONTAINED: '1', ...(auth !== undefined ? { VOLLEY_AUTH_MODE: auth } : {}) } },
          ),
        ).toThrow(/mangled/);
      }
      // Contained claude_cli critic behind a local builder is caught too, named.
      expect(() =>
        resolve_config(
          { ...base(workspace), builder_provider: 'ollama', critic_provider: 'claude_cli' },
          { env: { VOLLEY_CONTAINED: '1' } },
        ),
      ).toThrow(/critic/);
    } finally {
      cleanup();
    }
  });

  it('allows a contained claude_cli role in api_key mode, and any claude_cli on the host', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      // Contained + api_key: the key travels the boundary, so this resolves.
      expect(
        resolve_config(
          { ...base(workspace) },
          { env: { VOLLEY_CONTAINED: '1', VOLLEY_AUTH_MODE: 'api_key' } },
        ).builder_provider,
      ).toBe('claude_cli');
      // Uncontained (no marker): the host path is unaffected by the auth gate.
      expect(resolve_config(base(workspace), { env: {} }).builder_provider).toBe('claude_cli');
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
      const original = resolve_config(
        { ...base(workspace), builder_max_steps: 7 },
        { run_id: 'rt-run', env: {}, state_dir: null },
      );
      initialize_run_state(original);
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
      const original = resolve_config(base(workspace), {
        run_id: 'old-run',
        env: {},
        state_dir: null,
      });
      initialize_run_state(original);
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
      // A bare --worktree run keeps its work: it is salvaged onto the run branch,
      // not discarded.
      expect(config.discard_worktree).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('refuses --discard-worktree without --worktree rather than ignoring it', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      expect(resolve_config(base(workspace)).discard_worktree).toBe(false);
      mkdirSync(join(workspace, '.git'));
      // Alone it would read as isolation the run does not have.
      expect(() => resolve_config({ ...base(workspace), discard_worktree: true })).toThrow(
        /--discard-worktree applies only to a --worktree run/,
      );
      const config = resolve_config({
        ...base(workspace),
        worktree: true,
        discard_worktree: true,
      });
      expect(config.discard_worktree).toBe(true);
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
      const original = resolve_config(
        { ...base(workspace), sandbox_image: 'pinned/img:3' },
        { run_id: 'si-run', env: {}, state_dir: null },
      );
      initialize_run_state(original);
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

describe('resolve_config: per-seat model URLs', () => {
  /** Both seats local, contained, so neither the local-builder gate nor the
   * contained claude_cli gate stands in the way of the URL under test. */
  const CONTAINED = { env: { VOLLEY_CONTAINED: '1' } };

  it('defaults both seat URLs to null, so the provider env var and default apply', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config(local_seats(workspace), CONTAINED);
      expect(config.builder_url).toBeNull();
      expect(config.critic_url).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("takes each seat's own URL, trimmed, on an ollama or lmstudio seat", () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config(
        {
          ...local_seats(workspace),
          critic_provider: 'lmstudio',
          builder_url: ' http://localhost:11522 ',
          critic_url: 'https://critic-box:1235/v1',
        },
        CONTAINED,
      );
      expect(config.builder_url).toBe('http://localhost:11522');
      expect(config.critic_url).toBe('https://critic-box:1235/v1');
    } finally {
      cleanup();
    }
  });

  it('treats an empty seat URL as unset, on any provider', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config({ ...base(workspace), builder_url: '', critic_url: '  ' });
      expect(config.builder_url).toBeNull();
      expect(config.critic_url).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('refuses a URL on a claude_cli seat rather than ignoring it, naming the setting', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      for (const seat of ['builder', 'critic'] as const) {
        let caught: unknown;
        try {
          resolve_config({ ...base(workspace), [`${seat}_url`]: 'http://localhost:11434' });
        } catch (err) {
          caught = err;
        }
        expect(error_kind(caught)).toBe('config_error');
        expect(String(caught)).toContain(`--${seat}-url (${seat}_url)`);
        expect(String(caught)).toContain(`${seat}-provider is claude_cli`);
      }
    } finally {
      cleanup();
    }
  });

  it('refuses a URL that is not plain http(s)', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      for (const bad of [
        'localhost:11434',
        'not a url',
        'ftp://box:21',
        'http://box:11434/?keep_alive=1',
        'http://box:11434/#frag',
      ]) {
        expect(() =>
          resolve_config({ ...local_seats(workspace), critic_url: bad }, CONTAINED),
        ).toThrow(/--critic-url \(critic_url\)/);
      }
    } finally {
      cleanup();
    }
  });

  it('refuses credentials in a seat URL without echoing them', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      let caught: unknown;
      try {
        resolve_config(
          { ...local_seats(workspace), builder_url: 'http://admin:hunter2@box:11434' },
          CONTAINED,
        );
      } catch (err) {
        caught = err;
      }
      expect(error_kind(caught)).toBe('config_error');
      expect(String(caught)).toContain('must not carry credentials');
      expect(String(caught)).not.toContain('hunter2');
    } finally {
      cleanup();
    }
  });

  it('carries both seat URLs across a persist→restore round-trip', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const original = resolve_config(
        {
          ...local_seats(workspace),
          builder_url: 'http://localhost:11522',
          critic_url: 'http://localhost:11523',
        },
        { ...CONTAINED, run_id: 'url-run', state_dir: null },
      );
      initialize_run_state(original);
      write_resolved_config(original);
      const resume = load_resume_state(workspace, 'url-run');
      expect(resume.raw_config.builder_url).toBe('http://localhost:11522');
      expect(resume.raw_config.critic_url).toBe('http://localhost:11523');
      const restored = resolve_config(resume.raw_config, { ...CONTAINED, run_id: resume.run_id });
      expect(restored.builder_url).toBe('http://localhost:11522');
      expect(restored.critic_url).toBe('http://localhost:11523');
    } finally {
      cleanup();
    }
  });

  it('restores null seat URLs from a config that predates them', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const original = resolve_config(local_seats(workspace), {
        ...CONTAINED,
        run_id: 'old-url',
        state_dir: null,
      });
      initialize_run_state(original);
      write_resolved_config(original);
      const config_path = join(workspace, '.volley', 'config.json');
      const record = JSON.parse(readFileSync(config_path, 'utf8')) as Record<string, unknown>;
      delete record['builder_url'];
      delete record['critic_url'];
      writeFileSync(config_path, `${JSON.stringify(record, null, 2)}\n`);

      const resume = load_resume_state(workspace, 'old-url');
      const restored = resolve_config(resume.raw_config, { ...CONTAINED, run_id: resume.run_id });
      expect(restored.builder_url).toBeNull();
      expect(restored.critic_url).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe('resolve_config: the openrouter provider', () => {
  const KEYED = { OPENROUTER_API_KEY: 'sk-or-test' };

  /** Both seats on OpenRouter, the builder opted out of the sandbox. */
  function openrouter_seats(workspace: string) {
    return {
      ...base(workspace),
      builder_provider: 'openrouter' as const,
      critic_provider: 'openrouter' as const,
      allow_unsandboxed_builder: true,
    };
  }

  it('accepts openrouter for both seats, each with a URL of its own', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config(
        {
          ...openrouter_seats(workspace),
          builder_url: 'https://proxy.local/api/v1',
          critic_url: 'http://localhost:8080/v1',
        },
        { env: KEYED },
      );
      expect(config.builder_provider).toBe('openrouter');
      expect(config.critic_provider).toBe('openrouter');
      expect(config.builder_url).toBe('https://proxy.local/api/v1');
      expect(config.critic_url).toBe('http://localhost:8080/v1');
    } finally {
      cleanup();
    }
  });

  it('refuses an uncontained openrouter builder without the opt-out, since it gets a real bash', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      expect(() =>
        resolve_config(
          { ...openrouter_seats(workspace), allow_unsandboxed_builder: false },
          { env: KEYED },
        ),
      ).toThrow(/builder-provider 'openrouter' .*refused unless contained/);
      const contained = resolve_config(
        { ...openrouter_seats(workspace), allow_unsandboxed_builder: false },
        { env: { ...KEYED, VOLLEY_CONTAINED: '1' } },
      );
      expect(contained.builder_provider).toBe('openrouter');
    } finally {
      cleanup();
    }
  });

  it('refuses either seat on openrouter when OPENROUTER_API_KEY is unset or blank, naming it', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const builder_only = { ...openrouter_seats(workspace), critic_provider: 'claude_cli' as const };
      const critic_only = { ...base(workspace), critic_provider: 'openrouter' as const };
      for (const raw of [openrouter_seats(workspace), builder_only, critic_only]) {
        for (const env of [{}, { OPENROUTER_API_KEY: '  ' }]) {
          let caught: unknown;
          try {
            resolve_config(raw, { env });
          } catch (err) {
            caught = err;
          }
          expect(error_kind(caught)).toBe('config_error');
          expect(String(caught)).toContain('OPENROUTER_API_KEY is not set');
        }
      }
      // No openrouter seat, no key needed.
      expect(resolve_config(base(workspace), { env: {} }).builder_provider).toBe('claude_cli');
    } finally {
      cleanup();
    }
  });

  it('names every URL-taking provider when it refuses a URL on a claude_cli seat', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      expect(() =>
        resolve_config({ ...base(workspace), critic_url: 'http://localhost:11434' }),
      ).toThrow('applies only to a critic on ollama, lmstudio, or openrouter');
    } finally {
      cleanup();
    }
  });
});

describe('resolve_config: an uncontained builder under acp', () => {
  const KEYED = { OPENROUTER_API_KEY: 'sk-or-test' };

  it('asks before each command under acp rather than refusing, while the CLI still refuses', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      for (const provider of ['ollama', 'lmstudio', 'openrouter'] as const) {
        const raw = { ...base(workspace), builder_provider: provider };
        expect(() => resolve_config(raw, { env: KEYED })).toThrow(/refused unless contained/);
        expect(() => resolve_config(raw, { env: KEYED, uncontained_builder: 'refuse' })).toThrow(
          /refused unless contained/,
        );
        const config = resolve_config(raw, { env: KEYED, uncontained_builder: 'ask' });
        expect(config.builder_provider).toBe(provider);
        // Nobody opted out: each command asks instead.
        expect(config.allow_unsandboxed_builder).toBe(false);
      }
    } finally {
      cleanup();
    }
  });
});

describe('resolve_config: the check, resolved as the CLI resolves it', () => {
  const cases: Array<{ check: string; checkride: boolean; resolved: string }> = [
    { check: 'auto', checkride: true, resolved: 'checkride' },
    { check: 'auto', checkride: false, resolved: 'none' },
    { check: 'none', checkride: true, resolved: 'none' },
    { check: 'pnpm exec checkride', checkride: false, resolved: 'checkride' },
    { check: 'cat notes.md', checkride: true, resolved: 'command' },
  ];

  it.each(cases)(
    "resolves '$check' to $resolved (checkride in the workspace: $checkride)",
    ({ check, checkride, resolved }) => {
      const { workspace, cleanup } = temp_workspace();
      try {
        if (checkride) writeFileSync(join(workspace, 'checkride.config.json'), '{}');
        expect(resolve_config({ ...base(workspace), check }, { env: {} }).check_resolved).toBe(
          resolved,
        );
      } finally {
        cleanup();
      }
    },
  );
});

describe('resolve_config: the run id', () => {
  it("takes the caller's id as given, so it names the run's branch", () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const run_id = '5f0c2a1e-9b7d-4c3e-8a21-0d6f4b7e9c10';
      expect(resolve_config(base(workspace), { run_id, env: {} }).run_id).toBe(run_id);
      expect(resolve_config(base(workspace), { run_id: 'night_42-b', env: {} }).run_id).toBe(
        'night_42-b',
      );
    } finally {
      cleanup();
    }
  });

  it.each(['', '-rf', '../escape', 'a b', 'feat/x', 'x..y', 'id.lock'])(
    "refuses '%s', which a branch name cannot carry unquoted",
    (run_id) => {
      const { workspace, cleanup } = temp_workspace();
      try {
        let caught: unknown;
        try {
          resolve_config(base(workspace), { run_id, env: {} });
        } catch (err) {
          caught = err;
        }
        expect(error_kind(caught)).toBe('config_error');
        expect(String(caught)).toContain('--run-id');
      } finally {
        cleanup();
      }
    },
  );
});

describe('gate paths', () => {
  it('defaults to the shipped gate patterns, off by default as a refusal', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config(base(workspace));
      expect(config.gate_paths).toEqual(DEFAULT_GATE_PATTERNS);
      expect(config.fail_on_gate_edit).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('replaces the defaults rather than extending them — the task owns its gate', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config({ ...base(workspace), gate_paths: ['schema/**'] });
      expect(config.gate_paths).toEqual(['schema/**']);
    } finally {
      cleanup();
    }
  });

  it('accepts an empty list as "nothing here is the gate"', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      expect(resolve_config({ ...base(workspace), gate_paths: [] }).gate_paths).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('refuses a non-glob-list gate_paths as a config error', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      expect(() =>
        resolve_config({ ...base(workspace), gate_paths: [42] as unknown as string[] }),
      ).toThrow(/gate_paths/);
    } finally {
      cleanup();
    }
  });

  it('carries both settings across a resume', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config({
        ...base(workspace),
        gate_paths: ['schema/**'],
        fail_on_gate_edit: true,
      });
      initialize_run_state(config);
      write_resolved_config(config);
      const resumed = load_resume_state(workspace, config.run_id, config.state_dir);
      expect(resumed.raw_config.gate_paths).toEqual(['schema/**']);
      expect(resumed.raw_config.fail_on_gate_edit).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe('resolve_config: the run state directory', () => {
  it.skipIf(process.getuid?.() === 0)(
    'names the mount when a contained run has nowhere to write its state',
    () => {
      const { workspace, cleanup } = temp_workspace();
      // Unwritable, as the sandbox's read-only root filesystem is.
      const locked = mkdtempSync(join(tmpdir(), 'volley-locked-'));
      chmodSync(locked, 0o500);
      try {
        const env = { VOLLEY_CONTAINED: '1', VOLLEY_AUTH_MODE: 'api_key', XDG_STATE_HOME: locked };
        expect(() => resolve_config(base(workspace), { run_id: 'night-42', env })).toThrow(
          `run state directory not writable: ${join(locked, 'volley', 'night-42')}. ` +
            "Inside the sandbox, mount the run's own host directory there (sandbox_run_args run_state",
        );
        // A run directory that's already there and writable, as a mount is, passes.
        chmodSync(locked, 0o700);
        mkdirSync(join(locked, 'volley', 'night-42'), { recursive: true });
        chmodSync(locked, 0o500);
        chmodSync(join(locked, 'volley'), 0o500);
        expect(resolve_config(base(workspace), { run_id: 'night-42', env }).state_dir).toBe(
          join(locked, 'volley'),
        );
      } finally {
        chmodSync(locked, 0o700);
        if (existsSync(join(locked, 'volley'))) chmodSync(join(locked, 'volley'), 0o700);
        rmSync(locked, { recursive: true, force: true });
        cleanup();
      }
    },
  );
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

describe('detect_containment', () => {
  it('recognizes the VOLLEY_CONTAINED marker truthy values only', () => {
    expect(detect_containment({ VOLLEY_CONTAINED: '1' })).toBe(true);
    expect(detect_containment({ VOLLEY_CONTAINED: 'true' })).toBe(true);
    for (const value of ['0', 'false', '', 'yes', undefined]) {
      expect(detect_containment({ VOLLEY_CONTAINED: value })).toBe(false);
    }
    expect(detect_containment({})).toBe(false);
  });
});

describe('unguarded_builder', () => {
  it('holds only outside a container, with neither the flag nor the variable opting out', () => {
    expect(unguarded_builder({}, {})).toBe(true);
    expect(unguarded_builder({ allow_unsandboxed_builder: false }, { VOLLEY_CONTAINED: '0' })).toBe(true);
    expect(unguarded_builder({}, { VOLLEY_CONTAINED: '1' })).toBe(false);
    expect(unguarded_builder({ allow_unsandboxed_builder: true }, {})).toBe(false);
    expect(unguarded_builder({}, { VOLLEY_ALLOW_UNSANDBOXED_BUILDER: 'true' })).toBe(false);
  });
});

describe('package_version', () => {
  it('reports the manifest version, so --version cannot drift from the release', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(package_version()).toBe(manifest.version);
    // Guards the fallback: a resolution failure would report `unknown`, not a
    // stale-but-plausible number.
    expect(package_version()).toMatch(/^\d+\.\d+\.\d+/);
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
