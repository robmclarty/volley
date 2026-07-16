import { describe, expect, it } from 'vitest';
import { resolve_config } from '../../src/config.js';
import { is_local_builder, model_endpoint, preflight } from '../../src/preflight.js';
import type { PreflightProbes } from '../../src/preflight.js';
import { EXIT_CONFIG_ERROR, EXIT_SUCCESS } from '../../src/exit_codes.js';
import { create_renderer } from '../../src/render/renderer.js';
import type { ResolvedConfig } from '../../src/types.js';
import { temp_workspace } from '../helpers/harness.js';

function base(workspace: string) {
  return { prompt: 'do it', workspace, criteria: 'it is done' };
}

/** A renderer that captures its lines so error messages can be asserted. */
function capturing_renderer() {
  const out: string[] = [];
  const renderer = create_renderer({
    mode: 'default',
    show_thinking: true,
    color: false,
    max_cost_usd: null,
    write: (text) => out.push(text),
  });
  return { renderer, output: () => out.join('') };
}

/** Every containment probe green, so only the config under test decides the code. */
const ALL_GREEN: PreflightProbes = {
  toolchain_missing: () => [],
  worktree_creatable: () => ({ ok: true, detail: 'ws' }),
  endpoint_reachable: async () => true,
  checkride_doctor: () => true,
};

function claude_config(workspace: string): ResolvedConfig {
  return resolve_config(base(workspace));
}

/** A resolved local-builder config (fully local, so the contained claude_cli auth
 * gate does not apply). `worktree` is applied post-resolve so a test need not
 * stand up a git repo just to exercise the (injected) worktree probe. */
function local_config(workspace: string, opts: { worktree?: boolean } = {}): ResolvedConfig {
  const config = resolve_config(
    { ...base(workspace), builder_provider: 'ollama', critic_provider: 'ollama' },
    { env: { VOLLEY_CONTAINED: '1' } },
  );
  config.worktree = opts.worktree ?? false;
  return config;
}

describe('is_local_builder', () => {
  it('is true only for the local providers', () => {
    expect(is_local_builder('ollama')).toBe(true);
    expect(is_local_builder('lmstudio')).toBe(true);
    expect(is_local_builder('claude_cli')).toBe(false);
  });
});

describe('model_endpoint', () => {
  it('crosses a loopback ollama URL to the host gateway when VOLLEY_MODEL_HOST is set', () => {
    expect(model_endpoint('ollama', { VOLLEY_MODEL_HOST: 'host.docker.internal' })).toBe(
      'http://host.docker.internal:11434',
    );
    expect(model_endpoint('ollama', {})).toBe('http://localhost:11434');
  });
});

describe('preflight — all-Claude path never exits 5 from containment (C4)', () => {
  it('skips the containment checks even when the probes would fail', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer } = capturing_renderer();
      const code = await preflight(claude_config(workspace), renderer, {}, {
        toolchain_missing: () => ['pnpm'],
        worktree_creatable: () => ({ ok: false, detail: 'no repo' }),
        endpoint_reachable: async () => false,
      });
      expect(code).toBe(EXIT_SUCCESS);
    } finally {
      cleanup();
    }
  });
});

describe('preflight — containment checks for a local builder', () => {
  it('exits 0 when the toolchain, worktree, and endpoint are all present', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer, output } = capturing_renderer();
      const config = local_config(workspace, { worktree: true });
      const code = await preflight(config, renderer, { VOLLEY_MODEL_HOST: 'host.docker.internal' }, ALL_GREEN);
      expect(code).toBe(EXIT_SUCCESS);
      expect(output()).toContain('host.docker.internal');
    } finally {
      cleanup();
    }
  });

  it('exits 5 when the toolchain is missing', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer, output } = capturing_renderer();
      const code = await preflight(local_config(workspace), renderer, {}, {
        ...ALL_GREEN,
        toolchain_missing: () => ['pnpm', 'git'],
      });
      expect(code).toBe(EXIT_CONFIG_ERROR);
      expect(output()).toMatch(/missing toolchain.*pnpm, git/);
    } finally {
      cleanup();
    }
  });

  it('exits 5 when a requested worktree is not creatable', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer } = capturing_renderer();
      const code = await preflight(local_config(workspace, { worktree: true }), renderer, {}, {
        ...ALL_GREEN,
        worktree_creatable: () => ({ ok: false, detail: 'not a git work tree' }),
      });
      expect(code).toBe(EXIT_CONFIG_ERROR);
    } finally {
      cleanup();
    }
  });

  it('does not consult the worktree probe when --worktree is off', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer } = capturing_renderer();
      let consulted = false;
      const code = await preflight(local_config(workspace), renderer, {}, {
        ...ALL_GREEN,
        worktree_creatable: () => {
          consulted = true;
          return { ok: false, detail: 'should not be reached' };
        },
      });
      expect(code).toBe(EXIT_SUCCESS);
      expect(consulted).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('exits 5 when the host LLM endpoint is unreachable', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer, output } = capturing_renderer();
      const code = await preflight(local_config(workspace), renderer, { VOLLEY_MODEL_HOST: 'host.docker.internal' }, {
        ...ALL_GREEN,
        endpoint_reachable: async () => false,
      });
      expect(code).toBe(EXIT_CONFIG_ERROR);
      expect(output()).toMatch(/endpoint unreachable.*host\.docker\.internal/);
    } finally {
      cleanup();
    }
  });
});

describe('preflight — checkride doctor gates both paths', () => {
  it('exits 5 when checkride doctor fails', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer } = capturing_renderer();
      const config = claude_config(workspace);
      config.check_resolved = 'checkride';
      const code = await preflight(config, renderer, {}, { ...ALL_GREEN, checkride_doctor: () => false });
      expect(code).toBe(EXIT_CONFIG_ERROR);
    } finally {
      cleanup();
    }
  });
});
