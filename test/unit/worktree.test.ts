import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  build_root,
  create_worktree,
  teardown_worktree,
  with_worktree,
  worktree_branch,
  worktree_path,
} from '../../src/worktree.js';
import { error_kind } from '../../src/types.js';
import { temp_git_workspace, temp_workspace } from '../helpers/harness.js';

function git_out(repo: string, args: string[]): string {
  return spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).stdout ?? '';
}

function branch_names(repo: string): string[] {
  return git_out(repo, ['branch', '--list', '--format=%(refname:short)'])
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function worktree_dirs(repo: string): string[] {
  return git_out(repo, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length));
}

/** Sibling `.worktree.bak.*` directories left by a rotation. */
function rotated_dirs(workspace: string): string[] {
  const path = worktree_path(workspace);
  const prefix = `${basename(path)}.bak.`;
  return readdirSync(dirname(path))
    .filter((e) => e.startsWith(prefix))
    .map((e) => join(dirname(path), e));
}

describe('worktree_path / worktree_branch', () => {
  it('places the worktree beside the workspace and names the branch per run', () => {
    expect(worktree_path('/tmp/proj')).toBe('/tmp/proj.worktree');
    expect(worktree_branch('abc-123')).toBe('volley/abc-123');
  });
});

describe('build_root', () => {
  it('re-points to the worktree when on, and stays the workspace when off (s2 D3)', () => {
    expect(build_root('/tmp/proj', true)).toBe(worktree_path('/tmp/proj'));
    expect(build_root('/tmp/proj', false)).toBe('/tmp/proj');
  });
});

describe('create_worktree', () => {
  it('checks the branch out into a fresh sibling worktree', () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const handle = create_worktree({ workspace, branch: worktree_branch('run1') });

      expect(handle.path).toBe(worktree_path(workspace));
      expect(handle.branch).toBe('volley/run1');
      expect(existsSync(handle.path)).toBe(true);
      // git reports the canonical path (macOS /var → /private/var symlink).
      expect(worktree_dirs(workspace)).toContain(realpathSync(handle.path));
      expect(branch_names(workspace)).toContain('volley/run1');
      // HEAD of the new worktree is the per-run branch.
      expect(git_out(handle.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('volley/run1');
    } finally {
      cleanup();
    }
  });

  it('links the workspace node_modules into the fresh worktree (toolchain rides along)', () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      // node_modules is untracked, so the checkout alone would leave the
      // worktree toolchain-less; create_worktree links the workspace's in.
      mkdirSync(join(workspace, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(join(workspace, 'node_modules', '.bin', 'tool'), '#!/bin/sh\n');

      const handle = create_worktree({ workspace, branch: worktree_branch('run1') });

      const linked = join(handle.path, 'node_modules');
      expect(lstatSync(linked).isSymbolicLink()).toBe(true);
      expect(existsSync(join(linked, '.bin', 'tool'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('rotates a dirty/existing worktree aside and logs, preserving its files (D7)', () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const branch = worktree_branch('run1');
      const first = create_worktree({ workspace, branch });
      // Leave an uncommitted file in the worktree: it is "dirty".
      writeFileSync(join(first.path, 'scratch.txt'), 'work in progress');

      const logs: string[] = [];
      const second = create_worktree({ workspace, branch, log: (m) => logs.push(m) });

      // The rotation logged (mirroring the .volley.bak.<stamp> precedent).
      expect(logs.some((l) => l.includes('rotated existing'))).toBe(true);
      // The dirty file survives in the rotated-aside backup — never destroyed.
      const backups = rotated_dirs(workspace);
      expect(backups.length).toBeGreaterThan(0);
      const preserved = backups.some(
        (b) => existsSync(join(b, 'scratch.txt')) &&
          readFileSync(join(b, 'scratch.txt'), 'utf8') === 'work in progress',
      );
      expect(preserved).toBe(true);
      // A fresh worktree took its place at the canonical path.
      expect(existsSync(second.path)).toBe(true);
      expect(existsSync(join(second.path, 'scratch.txt'))).toBe(false);
      expect(worktree_dirs(workspace)).toContain(realpathSync(second.path));
    } finally {
      cleanup();
    }
  });

  it('rotates an existing branch aside rather than clobbering its commits', () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const branch = worktree_branch('run1');
      create_worktree({ workspace, branch });

      const logs: string[] = [];
      create_worktree({ workspace, branch, log: (m) => logs.push(m) });

      expect(logs.some((l) => l.includes('rotated existing branch'))).toBe(true);
      const names = branch_names(workspace);
      // Fresh branch present; the prior one preserved under a .bak. name.
      expect(names).toContain('volley/run1');
      expect(names.some((n) => n.startsWith('volley/run1.bak.'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('throws a config error when the workspace is not a git repository', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      let caught: unknown;
      try {
        create_worktree({ workspace, branch: worktree_branch('run1') });
      } catch (err) {
        caught = err;
      }
      expect(error_kind(caught)).toBe('config_error');
    } finally {
      cleanup();
    }
  });
});

describe('teardown_worktree', () => {
  it('removes the worktree and its branch (the D13 trio)', () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const branch = worktree_branch('run1');
      const handle = create_worktree({ workspace, branch });
      expect(existsSync(handle.path)).toBe(true);

      teardown_worktree({ workspace, branch });

      expect(existsSync(handle.path)).toBe(false);
      expect(worktree_dirs(workspace)).not.toContain(handle.path);
      expect(branch_names(workspace)).not.toContain(branch);
    } finally {
      cleanup();
    }
  });

  it('is idempotent: a second teardown (or one that never created) is a safe no-op', () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const branch = worktree_branch('run1');
      create_worktree({ workspace, branch });
      teardown_worktree({ workspace, branch });
      // Second call, and a call for a branch that was never created: no throw.
      expect(() => teardown_worktree({ workspace, branch })).not.toThrow();
      expect(() => teardown_worktree({ workspace, branch: worktree_branch('never') })).not.toThrow();
    } finally {
      cleanup();
    }
  });
});

describe('with_worktree', () => {
  it('disabled: passes the body through without touching git', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const value = await with_worktree(
        { enabled: false, workspace, branch: worktree_branch('run1') },
        async () => 42,
      );
      expect(value).toBe(42);
      expect(existsSync(worktree_path(workspace))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('enabled: creates the worktree for the body, then tears it down', async () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const branch = worktree_branch('run1');
      let saw_worktree = false;
      const value = await with_worktree({ enabled: true, workspace, branch }, async () => {
        saw_worktree = existsSync(worktree_path(workspace));
        return 'done';
      });

      expect(value).toBe('done');
      expect(saw_worktree).toBe(true);
      // Torn down after the body: no directory, no branch.
      expect(existsSync(worktree_path(workspace))).toBe(false);
      expect(branch_names(workspace)).not.toContain(branch);
    } finally {
      cleanup();
    }
  });

  it('enabled: tears the worktree down even when the body throws', async () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const branch = worktree_branch('run1');
      await expect(
        with_worktree({ enabled: true, workspace, branch }, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(existsSync(worktree_path(workspace))).toBe(false);
      expect(branch_names(workspace)).not.toContain(branch);
    } finally {
      cleanup();
    }
  });
});
