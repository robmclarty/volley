/**
 * Volley's own git runs filters the repo's config names, and a builder can
 * write that config. Each git call here passes through a clean/smudge filter
 * that dumps its environment, the way a planted one would, and must show
 * `PATH` but neither seat's key.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capture_baseline, collect_changes, DEFAULT_GATE_PATTERNS } from '../../src/changes.js';
import { git_checkpoint, integrate_worktree } from '../../src/workspace.js';
import { create_worktree, worktree_branch } from '../../src/worktree.js';
import { temp_git_workspace, temp_workspace } from '../helpers/harness.js';

function git(repo: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

/** A repo whose `*.txt` files pass through a filter that appends git's
 * environment to `leak`, with one such file committed. */
function filtered_repo(): { workspace: string; leak: string; cleanup: () => void } {
  const repo = temp_git_workspace();
  const outside = temp_workspace();
  const leak = join(outside.workspace, 'leak.env');
  const dump = `env >> '${leak}'; cat`;
  git(repo.workspace, ['config', 'filter.dump.clean', dump]);
  git(repo.workspace, ['config', 'filter.dump.smudge', dump]);
  writeFileSync(join(repo.workspace, '.gitattributes'), '*.txt filter=dump\n');
  writeFileSync(join(repo.workspace, 'a.txt'), 'one\n');
  git(repo.workspace, ['add', '-A']);
  git(repo.workspace, ['commit', '-q', '-m', 'seed']);
  return {
    workspace: repo.workspace,
    leak,
    cleanup: () => {
      repo.cleanup();
      outside.cleanup();
    },
  };
}

/** Set both seats' keys, empty `leak`, run `act`, and return what the filter
 * saw. */
function seen_by_filter(leak: string, act: () => void): string {
  vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-secret');
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-secret');
  writeFileSync(leak, '');
  act();
  return readFileSync(leak, 'utf8');
}

/** The filter ran (git puts its own exec path ahead of `PATH`, so only the
 * name is matched) and saw neither key. */
function expect_no_keys(seen: string): void {
  expect(seen).toMatch(/^PATH=/m);
  expect(seen).not.toContain('OPENROUTER_API_KEY');
  expect(seen).not.toContain('ANTHROPIC_API_KEY');
  expect(seen).not.toContain('secret');
}

describe("volley's git: no seat key reaches a filter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('git_checkpoint', () => {
    const { workspace, leak, cleanup } = filtered_repo();
    try {
      writeFileSync(join(workspace, 'a.txt'), 'two\n');
      expect_no_keys(seen_by_filter(leak, () => git_checkpoint(workspace, 'checkpoint')));
    } finally {
      cleanup();
    }
  });

  it('collect_changes', () => {
    const { workspace, leak, cleanup } = filtered_repo();
    try {
      const baseline = capture_baseline(workspace);
      writeFileSync(join(workspace, 'a.txt'), 'two\n');
      const seen = seen_by_filter(leak, () => {
        collect_changes({ root: workspace, baseline, gate_patterns: DEFAULT_GATE_PATTERNS });
      });
      expect_no_keys(seen);
    } finally {
      cleanup();
    }
  });

  it('create_worktree and integrate_worktree', () => {
    const { workspace, leak, cleanup } = filtered_repo();
    try {
      const branch = worktree_branch('run1');
      const handle = { path: '' };
      expect_no_keys(
        seen_by_filter(leak, () => {
          handle.path = create_worktree({ workspace, branch }).path;
        }),
      );
      writeFileSync(join(handle.path, 'a.txt'), 'two\n');
      git_checkpoint(handle.path, 'checkpoint');
      expect_no_keys(seen_by_filter(leak, () => integrate_worktree(workspace, branch, 'integrate')));
    } finally {
      cleanup();
    }
  });
});
