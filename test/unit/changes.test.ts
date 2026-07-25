import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GATE_PATTERNS,
  capture_baseline,
  collect_changes,
  matches_any,
} from '../../src/changes.js';
import { temp_git_workspace, temp_workspace } from '../helpers/harness.js';

function git(repo: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function write(repo: string, path: string, content: string): void {
  const full = join(repo, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

/** A repo with a committed baseline: one source file and one test file. */
function seeded_repo(): { workspace: string; baseline: string; cleanup: () => void } {
  const { workspace, cleanup } = temp_git_workspace();
  write(workspace, 'src/amount.mjs', 'export const parse = () => 0;\n');
  write(workspace, 'test/amount.test.mjs', 'import "node:test";\n');
  git(workspace, ['add', '-A']);
  git(workspace, ['commit', '-q', '-m', 'seed']);
  const baseline = capture_baseline(workspace);
  if (baseline === null) throw new Error('baseline not captured');
  return { workspace, baseline, cleanup };
}

function changes_of(workspace: string, baseline: string | null) {
  return collect_changes({ root: workspace, baseline, gate_patterns: DEFAULT_GATE_PATTERNS });
}

describe('matches_any', () => {
  it('matches a leading globstar at every depth', () => {
    expect(matches_any('test/a.mjs', ['**/test/**'])).toBe(true);
    expect(matches_any('src/test/a.mjs', ['**/test/**'])).toBe(true);
    expect(matches_any('src/tested/a.mjs', ['**/test/**'])).toBe(false);
  });

  it('keeps a single star inside one path segment', () => {
    expect(matches_any('a.test.mjs', ['**/*.test.*'])).toBe(true);
    expect(matches_any('src/a.test.mjs', ['**/*.test.*'])).toBe(true);
    expect(matches_any('src/a.mjs', ['**/*.test.*'])).toBe(false);
  });

  it('treats regex metacharacters in a pattern as literals', () => {
    expect(matches_any('package.json', ['**/package.json'])).toBe(true);
    // `.` is a literal here, not "any character".
    expect(matches_any('packageXjson', ['**/package.json'])).toBe(false);
  });

  it('matches one character per question mark', () => {
    expect(matches_any('a1.mjs', ['a?.mjs'])).toBe(true);
    expect(matches_any('a12.mjs', ['a?.mjs'])).toBe(false);
  });

  it('is false for an empty pattern list', () => {
    expect(matches_any('src/a.mjs', [])).toBe(false);
  });
});

describe('capture_baseline', () => {
  it('reads HEAD in a repository with commits', () => {
    const { baseline, cleanup } = seeded_repo();
    try {
      expect(baseline).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      cleanup();
    }
  });

  it('is null outside a git repository', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      expect(capture_baseline(workspace)).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe('collect_changes', () => {
  it('is null outside a git repository, so consumers can omit rather than lie', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      expect(changes_of(workspace, null)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('reports modified, added, and deleted paths against the baseline', () => {
    const { workspace, baseline, cleanup } = seeded_repo();
    try {
      write(workspace, 'src/amount.mjs', 'export const parse = () => 1;\n');
      write(workspace, 'src/parse.mjs', 'export const parse = () => 2;\n');
      rmSync(join(workspace, 'test/amount.test.mjs'));

      const changes = changes_of(workspace, baseline);
      expect(changes?.files).toEqual([
        { path: 'src/amount.mjs', status: 'modified', gate: false },
        { path: 'src/parse.mjs', status: 'added', gate: false },
        { path: 'test/amount.test.mjs', status: 'deleted', gate: true },
      ]);
      expect(changes?.total).toBe(3);
      expect(changes?.truncated).toBe(false);
      expect(changes?.baseline).toBe(baseline);
    } finally {
      cleanup();
    }
  });

  it('sees the builder\'s work whether it was committed or left dirty', () => {
    const { workspace, baseline, cleanup } = seeded_repo();
    try {
      write(workspace, 'src/committed.mjs', 'export const a = 1;\n');
      git(workspace, ['add', '-A']);
      git(workspace, ['commit', '-q', '-m', 'checkpoint']);
      write(workspace, 'src/dirty.mjs', 'export const b = 2;\n');

      const paths = changes_of(workspace, baseline)?.files.map((file) => file.path);
      expect(paths).toEqual(['src/committed.mjs', 'src/dirty.mjs']);
    } finally {
      cleanup();
    }
  });

  it('flags a deleted test as a gate edit — the sneakiest way to a green check', () => {
    const { workspace, baseline, cleanup } = seeded_repo();
    try {
      rmSync(join(workspace, 'test/amount.test.mjs'));
      expect(changes_of(workspace, baseline)?.gate_edits).toEqual(['test/amount.test.mjs']);
    } finally {
      cleanup();
    }
  });

  it('leaves gate_edits empty when only source changed', () => {
    const { workspace, baseline, cleanup } = seeded_repo();
    try {
      write(workspace, 'src/amount.mjs', 'export const parse = () => 3;\n');
      const changes = changes_of(workspace, baseline);
      expect(changes?.gate_edits).toEqual([]);
      expect(changes?.files.every((file) => !file.gate)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('honours a config\'s own gate patterns instead of the defaults', () => {
    const { workspace, baseline, cleanup } = seeded_repo();
    try {
      write(workspace, 'test/amount.test.mjs', 'import "node:test"; // edited\n');
      write(workspace, 'src/amount.mjs', 'export const parse = () => 4;\n');
      const changes = collect_changes({
        root: workspace,
        baseline,
        // A task that owns its tests but must not touch the implementation.
        gate_patterns: ['src/**'],
      });
      expect(changes?.gate_edits).toEqual(['src/amount.mjs']);
    } finally {
      cleanup();
    }
  });

  it('excludes harness state and the toolchain from the builder\'s work', () => {
    const { workspace, baseline, cleanup } = seeded_repo();
    try {
      write(workspace, '.volley/summary.json', '{}\n');
      write(workspace, '.check/summary.json', '{}\n');
      write(workspace, 'node_modules/left-pad/index.js', 'module.exports = 1;\n');
      write(workspace, 'src/real.mjs', 'export const c = 3;\n');

      const paths = changes_of(workspace, baseline)?.files.map((file) => file.path);
      expect(paths).toEqual(['src/real.mjs']);
    } finally {
      cleanup();
    }
  });

  it('caps the file list but never the gate edits or the total', () => {
    const { workspace, baseline, cleanup } = seeded_repo();
    try {
      write(workspace, 'src/a.mjs', 'export const a = 1;\n');
      write(workspace, 'src/b.mjs', 'export const b = 2;\n');
      write(workspace, 'test/z.test.mjs', 'import "node:test";\n');

      const changes = collect_changes({
        root: workspace,
        baseline,
        gate_patterns: DEFAULT_GATE_PATTERNS,
        limit: 1,
      });
      expect(changes?.files).toHaveLength(1);
      expect(changes?.truncated).toBe(true);
      expect(changes?.total).toBe(3);
      // Sorted last, past the cap, and still reported.
      expect(changes?.gate_edits).toEqual(['test/z.test.mjs']);
    } finally {
      cleanup();
    }
  });

  it('reports untracked files in a repository with no commits yet', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      git(workspace, ['init', '-q']);
      write(workspace, 'src/fresh.mjs', 'export const d = 4;\n');
      const changes = changes_of(workspace, capture_baseline(workspace));
      expect(changes?.baseline).toBeNull();
      expect(changes?.files).toEqual([{ path: 'src/fresh.mjs', status: 'added', gate: false }]);
    } finally {
      cleanup();
    }
  });

  it('reports an empty change set when the builder changed nothing', () => {
    const { workspace, baseline, cleanup } = seeded_repo();
    try {
      const changes = changes_of(workspace, baseline);
      expect(changes).toEqual({
        baseline,
        files: [],
        gate_edits: [],
        total: 0,
        truncated: false,
      });
    } finally {
      cleanup();
    }
  });
});
