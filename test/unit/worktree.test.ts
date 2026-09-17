import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  build_root,
  create_worktree,
  report_worktree_fate,
  teardown_worktree,
  with_worktree,
  worktree_branch,
  worktree_fate,
  worktree_notice,
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

/** The worktree's own git directory (`<repo>/.git/worktrees/<name>`), read off
 * the `gitdir:` pointer git writes into a linked worktree's `.git` file. */
function worktree_gitdir(worktree: string): string {
  return readFileSync(join(worktree, '.git'), 'utf8').replace('gitdir:', '').trim();
}

/** A `NoticeSink` that records which channel each line was written to. */
function notice_sink() {
  const info_lines: string[] = [];
  const warn_lines: string[] = [];
  return {
    info: (message: string) => info_lines.push(message),
    warn: (message: string) => warn_lines.push(message),
    info_lines,
    warn_lines,
  };
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
  it('re-points to the worktree when on, and stays the workspace when off', () => {
    expect(build_root('/tmp/proj', true)).toBe(worktree_path('/tmp/proj'));
    expect(build_root('/tmp/proj', false)).toBe('/tmp/proj');
  });
});

/** The three fate-deciding config fields, defaulted off. */
function fate_config(overrides: {
  worktree?: boolean;
  git_checkpoints?: boolean;
  discard_worktree?: boolean;
} = {}) {
  return {
    worktree: overrides.worktree ?? false,
    git_checkpoints: overrides.git_checkpoints ?? false,
    discard_worktree: overrides.discard_worktree ?? false,
  };
}

describe('worktree_fate', () => {
  it('is none without --worktree, whatever the other flags say', () => {
    expect(worktree_fate(fate_config())).toBe('none');
    expect(worktree_fate(fate_config({ git_checkpoints: true }))).toBe('none');
  });

  it('integrates under --worktree --git and discards under --discard-worktree', () => {
    expect(worktree_fate(fate_config({ worktree: true, git_checkpoints: true }))).toBe('integrate');
    expect(worktree_fate(fate_config({ worktree: true, discard_worktree: true }))).toBe('discard');
  });

  it('keeps --git winning, so asking for a throw-away run cannot silently stop integration', () => {
    expect(
      worktree_fate(fate_config({ worktree: true, git_checkpoints: true, discard_worktree: true })),
    ).toBe('integrate');
  });

  it('salvages a bare --worktree run: the case that used to be force-deleted', () => {
    expect(worktree_fate(fate_config({ worktree: true }))).toBe('salvage');
  });
});

describe('worktree_notice / report_worktree_fate', () => {
  it('says nothing when --worktree is off', () => {
    expect(worktree_notice(fate_config())).toBeNull();
    const sink = notice_sink();
    report_worktree_fate(fate_config(), sink);
    expect(sink.info_lines).toEqual([]);
    expect(sink.warn_lines).toEqual([]);
  });

  it('warns that a bare --worktree run is not integrated, and names where the work lands', () => {
    const notice = worktree_notice(fate_config({ worktree: true }));
    expect(notice?.level).toBe('warn');
    expect(notice?.message).toContain('will NOT be integrated');
    expect(notice?.message).toContain('volley/<run id>');
    expect(notice?.message).toContain('--git');

    const sink = notice_sink();
    report_worktree_fate(fate_config({ worktree: true }), sink);
    expect(sink.warn_lines).toHaveLength(1);
    expect(sink.info_lines).toEqual([]);
  });

  it('reports the integrate and discard fates as info, not warnings', () => {
    const integrate = worktree_notice(fate_config({ worktree: true, git_checkpoints: true }));
    expect(integrate?.level).toBe('info');
    expect(integrate?.message).toContain('squash-merges');

    const discard = worktree_notice(fate_config({ worktree: true, discard_worktree: true }));
    expect(discard?.level).toBe('info');
    expect(discard?.message).toContain('thrown away');

    const sink = notice_sink();
    report_worktree_fate(fate_config({ worktree: true, discard_worktree: true }), sink);
    expect(sink.info_lines).toHaveLength(1);
    expect(sink.warn_lines).toEqual([]);
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

  it('rotates a dirty/existing worktree aside and logs, preserving its files', () => {
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
  it('removes the worktree and its branch (the teardown trio)', () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const branch = worktree_branch('run1');
      const handle = create_worktree({ workspace, branch });
      expect(existsSync(handle.path)).toBe(true);

      const outcome = teardown_worktree({ workspace, branch });

      expect(outcome).toEqual({ salvaged_branch: null, kept_path: null });
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
      // Salvaging a worktree that was never created is a no-op too, not a branch.
      expect(teardown_worktree({ workspace, branch, salvage: true })).toEqual({
        salvaged_branch: null,
        kept_path: null,
      });
    } finally {
      cleanup();
    }
  });

  it('salvage: commits the run’s work onto its branch and keeps it, removing only the checkout', () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const branch = worktree_branch('run1');
      const handle = create_worktree({ workspace, branch });
      // Uncommitted work — no `--git` checkpoints, so this is its only copy.
      writeFileSync(join(handle.path, 'out.txt'), 'done');

      const outcome = teardown_worktree({ workspace, branch, salvage: true });

      expect(outcome.salvaged_branch).toBe(branch);
      expect(outcome.kept_path).toBeNull();
      // The checkout is gone, but what it held is now a commit on the branch.
      expect(existsSync(handle.path)).toBe(false);
      expect(branch_names(workspace)).toContain(branch);
      expect(git_out(workspace, ['show', `${branch}:out.txt`])).toBe('done');
      // The workspace branch never moved: recovering the work stays the user's call.
      expect(git_out(workspace, ['ls-tree', '-r', '--name-only', 'HEAD'])).not.toContain('out.txt');
    } finally {
      cleanup();
    }
  });

  it('salvage: a run that changed nothing leaves no branch behind', () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const branch = worktree_branch('run1');
      create_worktree({ workspace, branch });

      const outcome = teardown_worktree({ workspace, branch, salvage: true });

      expect(outcome.salvaged_branch).toBeNull();
      expect(branch_names(workspace)).not.toContain(branch);
      expect(existsSync(worktree_path(workspace))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('salvage: is idempotent — a second salvaging teardown still reports the survivor', () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const branch = worktree_branch('run1');
      const handle = create_worktree({ workspace, branch });
      writeFileSync(join(handle.path, 'out.txt'), 'done');
      teardown_worktree({ workspace, branch, salvage: true });

      const second = teardown_worktree({ workspace, branch, salvage: true });

      expect(second.salvaged_branch).toBe(branch);
      expect(branch_names(workspace)).toContain(branch);
      expect(git_out(workspace, ['show', `${branch}:out.txt`])).toBe('done');
    } finally {
      cleanup();
    }
  });

  it('salvage: keeps the checkout standing when the work cannot be committed', () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const branch = worktree_branch('run1');
      const handle = create_worktree({ workspace, branch });
      writeFileSync(join(handle.path, 'out.txt'), 'done');
      // A stale index lock fails `git add`/`git commit`, so the run's work exists
      // only on disk — the one state teardown must not delete.
      writeFileSync(join(worktree_gitdir(handle.path), 'index.lock'), '');

      const outcome = teardown_worktree({ workspace, branch, salvage: true });

      expect(outcome.kept_path).toBe(handle.path);
      expect(outcome.salvaged_branch).toBeNull();
      expect(readFileSync(join(handle.path, 'out.txt'), 'utf8')).toBe('done');
      expect(branch_names(workspace)).toContain(branch);
    } finally {
      cleanup();
    }
  });
});

describe('with_worktree', () => {
  it('disabled: passes the body through without touching git', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const outcome = await with_worktree(
        { enabled: false, workspace, branch: worktree_branch('run1') },
        async () => 42,
      );
      expect(outcome).toEqual({ value: 42, salvaged_branch: null, kept_path: null });
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
      const outcome = await with_worktree({ enabled: true, workspace, branch }, async () => {
        saw_worktree = existsSync(worktree_path(workspace));
        return 'done';
      });

      expect(outcome.value).toBe('done');
      expect(outcome.salvaged_branch).toBeNull();
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
      let consulted = false;
      await expect(
        with_worktree(
          {
            enabled: true,
            workspace,
            branch,
            // A failed run is discarded wholesale: the predicate is never asked,
            // even one that would say "keep it".
            salvage: () => {
              consulted = true;
              return true;
            },
          },
          async () => {
            writeFileSync(join(worktree_path(workspace), 'out.txt'), 'half-done');
            throw new Error('boom');
          },
        ),
      ).rejects.toThrow('boom');

      expect(consulted).toBe(false);
      expect(existsSync(worktree_path(workspace))).toBe(false);
      expect(branch_names(workspace)).not.toContain(branch);
    } finally {
      cleanup();
    }
  });

  it('enabled: salvages when the predicate says the body’s work was not integrated', async () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const branch = worktree_branch('run1');
      const outcome = await with_worktree(
        { enabled: true, workspace, branch, salvage: (value) => value === 'success' },
        async () => {
          writeFileSync(join(worktree_path(workspace), 'out.txt'), 'done');
          return 'success';
        },
      );

      expect(outcome.value).toBe('success');
      expect(outcome.salvaged_branch).toBe(branch);
      // Checkout removed, branch kept with the work on it.
      expect(existsSync(worktree_path(workspace))).toBe(false);
      expect(branch_names(workspace)).toContain(branch);
      expect(git_out(workspace, ['show', `${branch}:out.txt`])).toBe('done');
    } finally {
      cleanup();
    }
  });

  it('enabled: a predicate that declines still gets the discarding teardown', async () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const branch = worktree_branch('run1');
      const outcome = await with_worktree(
        { enabled: true, workspace, branch, salvage: () => false },
        async () => {
          writeFileSync(join(worktree_path(workspace), 'out.txt'), 'thrown away');
          return 'discarded';
        },
      );

      expect(outcome.salvaged_branch).toBeNull();
      expect(existsSync(worktree_path(workspace))).toBe(false);
      expect(branch_names(workspace)).not.toContain(branch);
    } finally {
      cleanup();
    }
  });
});
