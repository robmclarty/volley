/**
 * The Claude builder's effects must land where every other phase looks: the
 * build root. Every other integration test injects a mock engine, which never
 * reaches `create_volley_engine`, so this one drives the real engine against a
 * stand-in `claude` binary (`VOLLEY_CLAUDE_BIN`) and checks where its writes go.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run_volley } from '../../src/orchestrator.js';
import { worktree_branch } from '../../src/worktree.js';
import { FAKE_CLAUDE_MARKER as MARKER, install_fake_claude } from '../helpers/fake_claude.js';
import { silent_renderer, temp_git_workspace, test_config } from '../helpers/harness.js';

describe('claude_cli builder under --worktree', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('runs the Claude session in the worktree, not the workspace', async () => {
    const { workspace, cleanup } = temp_git_workspace();
    const fake = install_fake_claude();
    try {
      vi.stubEnv('VOLLEY_CLAUDE_BIN', fake.bin);
      vi.stubEnv('VOLLEY_AUTH_MODE', 'auto');
      const config = test_config({ workspace, worktree: true });

      const result = await run_volley(config, {
        renderer: silent_renderer(),
        install_signal_handlers: false,
      });

      expect(result.status).toBe('success');
      // The builder never wrote into the operator's checkout...
      expect(existsSync(join(workspace, MARKER))).toBe(false);
      // ...it wrote into the worktree, which a plain --worktree run salvages onto
      // its run branch at teardown.
      const branch = worktree_branch(config.run_id);
      expect(result.salvaged_branch).toBe(branch);
      const shown = spawnSync('git', ['show', `${branch}:${MARKER}`], {
        cwd: workspace,
        encoding: 'utf8',
      });
      expect(shown.status).toBe(0);
      expect(shown.stdout).toContain('written by the fake builder');
    } finally {
      fake.remove();
      cleanup();
    }
  });
});
