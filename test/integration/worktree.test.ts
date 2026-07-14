import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { run_volley } from '../../src/orchestrator.js';
import { worktree_branch, worktree_path } from '../../src/worktree.js';
import { silent_renderer, temp_git_workspace, test_config } from '../helpers/harness.js';
import { approve_reply, mock_engine } from '../helpers/mock_engine.js';

function branch_exists(repo: string, branch: string): boolean {
  return spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo })
    .status === 0;
}

describe('orchestrator worktree lifecycle (deps.worktree)', () => {
  it('wraps the builder loop in a per-run worktree and tears it down after', async () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const config = test_config({ workspace, check: 'none', check_resolved: 'none' });
      let worktree_present_during_build = false;
      const engine = mock_engine((call) =>
        call.role === 'builder'
          ? {
              content: 'built',
              cost_usd: 0.1,
              effect: () => {
                // The worktree exists around the builder phase (done-when).
                worktree_present_during_build = existsSync(worktree_path(workspace));
                writeFileSync(join(workspace, 'out.txt'), 'done');
              },
            }
          : approve_reply(),
      );

      const result = await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
        worktree: true,
      });

      expect(result.status).toBe('success');
      expect(worktree_present_during_build).toBe(true);
      // Torn down when the run ended.
      expect(existsSync(worktree_path(workspace))).toBe(false);
      expect(branch_exists(workspace, worktree_branch(config.run_id))).toBe(false);
      // Step 7 does not re-point contain() yet: the build still lands in the
      // workspace, not the worktree.
      expect(existsSync(join(workspace, 'out.txt'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('leaves the default path untouched: no worktree, no branch', async () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const config = test_config({ workspace, check: 'none', check_resolved: 'none' });
      const engine = mock_engine((call) =>
        call.role === 'builder'
          ? { content: 'built', cost_usd: 0.1, effect: () => writeFileSync(join(workspace, 'out.txt'), 'done') }
          : approve_reply(),
      );

      const result = await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });

      expect(result.status).toBe('success');
      expect(existsSync(worktree_path(workspace))).toBe(false);
      expect(branch_exists(workspace, worktree_branch(config.run_id))).toBe(false);
    } finally {
      cleanup();
    }
  });
});
