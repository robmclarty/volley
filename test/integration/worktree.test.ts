import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { Tool } from 'fascicle';
import { run_volley } from '../../src/orchestrator.js';
import { worktree_branch, worktree_path } from '../../src/worktree.js';
import { silent_renderer, temp_git_workspace, test_config } from '../helpers/harness.js';
import { approve_reply, mock_engine } from '../helpers/mock_engine.js';

const ctx = {
  abort: new AbortController().signal,
  tool_call_id: 't',
  step_index: 0,
} as const;

function branch_exists(repo: string, branch: string): boolean {
  return spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo })
    .status === 0;
}

function git_porcelain(repo: string): string {
  return spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).stdout ?? '';
}

describe('orchestrator worktree lifecycle (config.worktree)', () => {
  it('wraps the builder loop in a per-run worktree and tears it down after', async () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const config = test_config({ workspace, worktree: true, check: 'none', check_resolved: 'none' });
      let worktree_present_during_build = false;
      const engine = mock_engine((call) =>
        call.role === 'builder'
          ? {
              content: 'built',
              cost_usd: 0.1,
              // The worktree exists around the builder phase (done-when).
              effect: () => {
                worktree_present_during_build = existsSync(worktree_path(workspace));
              },
            }
          : approve_reply(),
      );

      const result = await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });

      expect(result.status).toBe('success');
      expect(worktree_present_during_build).toBe(true);
      // Torn down when the run ended.
      expect(existsSync(worktree_path(workspace))).toBe(false);
      expect(branch_exists(workspace, worktree_branch(config.run_id))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('re-points the builder containment root into the worktree so git -C <worktree> shows the diff (step 8 done-when)', async () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      // A local builder brings volley's own tool surface; --worktree moves its
      // containment root to the worktree, so a write through the tool lands
      // there — not in the workspace.
      const config = test_config({
        workspace,
        worktree: true,
        builder_provider: 'ollama',
        builder_model: 'qwen3-coder:30b',
        allow_unsandboxed_builder: true,
        check: 'none',
        check_resolved: 'none',
      });
      let wrote_into_worktree = false;
      let absent_from_workspace = false;
      let worktree_diff = '';
      let workspace_diff = '';
      const engine = mock_engine((call) =>
        call.role === 'builder'
          ? {
              content: 'built',
              cost_usd: 0,
              // Stand in for the real tool loop by driving the supplied
              // write_file tool, which resolves through contain(build_root).
              effect: async (opts) => {
                const write = opts.tools?.find((t: Tool) => t.name === 'write_file');
                await write?.execute({ path: 'out.txt', content: 'done' }, ctx);
                const wt = worktree_path(workspace);
                wrote_into_worktree = existsSync(join(wt, 'out.txt'));
                absent_from_workspace = !existsSync(join(workspace, 'out.txt'));
                worktree_diff = git_porcelain(wt);
                workspace_diff = git_porcelain(workspace);
              },
            }
          : approve_reply(),
      );

      const result = await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });

      expect(result.status).toBe('success');
      // The build landed in the worktree, not the workspace.
      expect(wrote_into_worktree).toBe(true);
      expect(absent_from_workspace).toBe(true);
      // `git -C <worktree>` sees the new file; the workspace tree stays clean.
      expect(worktree_diff).toContain('out.txt');
      expect(workspace_diff).not.toContain('out.txt');
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
