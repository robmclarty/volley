import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { Tool } from 'fascicle';
import { run_volley } from '../../src/orchestrator.js';
import { worktree_branch, worktree_path } from '../../src/worktree.js';
import { git_checkpoint } from '../../src/workspace.js';
import { error_kind } from '../../src/types.js';
import { silent_renderer, temp_git_workspace, temp_workspace, test_config } from '../helpers/harness.js';
import { approve_reply, mock_engine, reject_reply } from '../helpers/mock_engine.js';

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

function commit_count(repo: string): number {
  return Number((spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout ?? '0').trim());
}

function tracked_at_head(repo: string): string {
  return spawnSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout ?? '';
}

function head_subject(repo: string): string {
  return (spawnSync('git', ['log', '-1', '--format=%s'], { cwd: repo, encoding: 'utf8' }).stdout ?? '').trim();
}

/** A local-builder config whose write_file tool lands in the worktree, with
 * `--git` checkpoints on. Drives the D13 checkpoint/integration path. */
function worktree_git_config(workspace: string, overrides: Record<string, unknown> = {}) {
  return test_config({
    workspace,
    worktree: true,
    git_checkpoints: true,
    builder_provider: 'ollama',
    builder_model: 'qwen3-coder:30b',
    allow_unsandboxed_builder: true,
    check: 'none',
    check_resolved: 'none',
    ...overrides,
  });
}

/** A builder that writes `out.txt` into its containment root (the worktree). */
function writing_builder() {
  return mock_engine((call) =>
    call.role === 'builder'
      ? {
          content: 'built',
          cost_usd: 0,
          effect: async (opts) => {
            const write = opts.tools?.find((t: Tool) => t.name === 'write_file');
            await write?.execute({ path: 'out.txt', content: 'done' }, ctx);
          },
        }
      : approve_reply(),
  );
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

describe('worktree-branch checkpoints + integration (D13, step 9)', () => {
  it('checkpoints on the worktree branch and squash-integrates onto the workspace branch on success', async () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const config = worktree_git_config(workspace);
      const engine = writing_builder();

      const before = commit_count(workspace); // 1 (root)
      const result = await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });

      expect(result.status).toBe('success');
      // The raw per-phase checkpoints landed on the (now-discarded) phase branch,
      // not the workspace branch: the workspace branch gained exactly one commit
      // — the squash integration — carrying the builder's effect (D13).
      expect(commit_count(workspace)).toBe(before + 1);
      expect(head_subject(workspace)).toContain('integrate worktree (squash)');
      expect(tracked_at_head(workspace)).toContain('out.txt');
      // Phase branch discarded wholesale; worktree gone; the squash left nothing
      // staged (untracked `.volley/` is expected — the test repo has no
      // .gitignore; the real workspace ignores it).
      expect(branch_exists(workspace, worktree_branch(config.run_id))).toBe(false);
      expect(existsSync(worktree_path(workspace))).toBe(false);
      const pending = git_porcelain(workspace)
        .split('\n')
        .filter((l) => l.trim().length > 0 && !l.startsWith('??'));
      expect(pending).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('abandons a non-success run: nothing integrated, the branch discarded wholesale', async () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const config = worktree_git_config(workspace, { max_iterations: 1 });
      // A builder that writes, but a critic that never approves: the run
      // exhausts its budget without converging (an abandoned phase).
      const engine = mock_engine((call) =>
        call.role === 'builder'
          ? {
              content: 'built',
              cost_usd: 0,
              effect: async (opts) => {
                const write = opts.tools?.find((t: Tool) => t.name === 'write_file');
                await write?.execute({ path: 'out.txt', content: 'done' }, ctx);
              },
            }
          : reject_reply('needs work', ['unmet']),
      );

      const before = commit_count(workspace);
      const result = await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });

      expect(result.status).toBe('budget_exhausted');
      // No integration: the workspace branch is untouched and the effect never
      // reached it; the phase branch (with its raw checkpoints) is gone.
      expect(commit_count(workspace)).toBe(before);
      expect(tracked_at_head(workspace)).not.toContain('out.txt');
      expect(branch_exists(workspace, worktree_branch(config.run_id))).toBe(false);
      expect(existsSync(worktree_path(workspace))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('still guards: git_checkpoint refuses a build root that is not a git repository', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      let caught: unknown;
      try {
        git_checkpoint(workspace, 'no repo here');
      } catch (err) {
        caught = err;
      }
      expect(error_kind(caught)).toBe('config_error');
    } finally {
      cleanup();
    }
  });
});
