/**
 * What the builder changed, and whether it touched the gate.
 *
 * Until now the harness's only view of a builder's work was "the check exited
 * 0" — which is exactly the thing a builder can arrange by editing the check.
 * The reckon run (`research/reckon-local-run-finding.md`) closed that hole by
 * hand: after a green all-local run, the salvage commit was inspected to confirm
 * it touched only the four source modules and no test, fixture, or manifest.
 * This module is that inspection, mechanized — diff the build root against a
 * baseline captured before the first iteration, classify every changed path
 * against the gate patterns, and hand the result to the critic prompt, the run
 * summary, and (opt-in) the loop's stopping condition.
 *
 * Everything here is best-effort and non-throwing. A build root that is not a
 * git repository simply has no change set (`null`) and the loop behaves exactly
 * as it did before: change detection is evidence, never a precondition.
 *
 * Deliberately *not* collected: diff hunks. The changed-path list is bounded and
 * cheap, while inlined content would blow a local critic's context (32k on the
 * reckon seats) for the one part of the picture its read tools can already
 * fetch — the critic learns *where* to look, then looks.
 */
import { spawnSync } from 'node:child_process';
import type { ChangeSet, ChangeStatus, ChangedFile } from './types.js';

/**
 * The default gate: paths whose edits change *what passing means* rather than
 * whether the work passes. Tests and fixtures are the executable half of the
 * spec; the check configuration and manifest decide which tests run at all.
 *
 * Deliberately broad and language-general — a false positive costs one line in
 * the critic's prompt, while a miss is the failure mode this exists to prevent.
 * A config's own `gate_paths` replaces the list outright (spec-writing tasks
 * legitimately own their tests).
 */
export const DEFAULT_GATE_PATTERNS: string[] = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/*_test.*',
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/spec/**',
  '**/fixtures/**',
  '**/checkride.config.*',
  '**/vitest.config.*',
  '**/jest.config.*',
  '**/playwright.config.*',
  '**/package.json',
  '.github/workflows/**',
];

/** Harness state, toolchain, and VCS internals: never the builder's work, even
 * when they sit in the build root and show up dirty. `.volley/` is the control
 * plane, `.check/` is the check's own artifacts, `node_modules/` rides in on the
 * worktree symlink. */
const EXCLUDED_PREFIXES = ['.volley/', '.volley.bak.', '.check/', '.git/', 'node_modules/'];

/** How many changed paths the set carries. The cap bounds the critic prompt and
 * the archived summary on a sweeping refactor; `gate_edits` and `total` are
 * always computed over the full list, so nothing load-bearing is truncated. */
const DEFAULT_LIMIT = 200;

type GitResult = { status: number; stdout: string };

/** Run git in `root`, best-effort: a missing binary, a broken repo, or a
 * non-zero exit all read as "no output". Change detection reports what it can
 * and never fails a run over what it cannot (unlike `worktree.ts`, where git is
 * a precondition the operator asked for). */
function git(root: string, args: string[]): GitResult {
  try {
    const result = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return { status: result.status ?? -1, stdout: result.stdout ?? '' };
  } catch {
    return { status: -1, stdout: '' };
  }
}

/** Is this directory inside a git repository? Asked of git rather than by
 * looking for `.git`, so a workspace nested under a repo root — and a linked
 * worktree, whose `.git` is a file — both answer correctly. */
function in_git_repo(root: string): boolean {
  return git(root, ['rev-parse', '--git-dir']).status === 0;
}

/**
 * The commit a run's changes are measured against: the build root's HEAD, read
 * once before the first iteration. Null when the root is not a repository or has
 * no commits yet — in the latter case `collect_changes` still reports untracked
 * files, which is the whole of a from-scratch build.
 */
export function capture_baseline(root: string): string | null {
  const head = git(root, ['rev-parse', 'HEAD']);
  if (head.status !== 0) return null;
  const sha = head.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/** git's status letters, folded onto the four cases worth naming. Rename and
 * copy both record the destination path — where the content lives now. */
function change_status(code: string): ChangeStatus {
  const letter = code.charAt(0);
  if (letter === 'A') return 'added';
  if (letter === 'M' || letter === 'T') return 'modified';
  if (letter === 'D') return 'deleted';
  if (letter === 'R' || letter === 'C') return 'renamed';
  return 'unknown';
}

type RawChange = { path: string; status: ChangeStatus };

/**
 * Parse `git diff --name-status -z`: a flat NUL-separated stream of
 * `status, path` pairs, except renames and copies, which carry `status, source,
 * destination`. NUL separation (rather than lines) is what makes paths with
 * spaces or newlines in them safe to read.
 */
function parse_name_status(stdout: string): RawChange[] {
  const tokens = stdout.split('\0').filter((token) => token.length > 0);
  const changes: RawChange[] = [];
  let index = 0;
  while (index < tokens.length) {
    const code = tokens[index] ?? '';
    const paired = code.startsWith('R') || code.startsWith('C');
    const path = tokens[index + (paired ? 2 : 1)];
    if (path !== undefined) changes.push({ path, status: change_status(code) });
    index += paired ? 3 : 2;
  }
  return changes;
}

/** Parse a NUL-separated path list (`git ls-files -z`). */
function parse_paths(stdout: string): string[] {
  return stdout.split('\0').filter((path) => path.length > 0);
}

function excluded(path: string): boolean {
  return EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Compile one glob to an anchored regular expression. Supports the three forms
 * the gate patterns need — `**` across separators, `*` within a segment, `?` for
 * one character — in a single pass, because sequential string replacement would
 * re-process the regex syntax its own earlier passes emit.
 *
 * A leading globstar-plus-separator collapses to "any number of leading
 * segments, including none", so one `test` pattern matches `test/a.mjs` and
 * `src/test/a.mjs` alike instead of needing a rule per depth.
 */
function glob_to_regexp(pattern: string): RegExp {
  let source = '';
  let index = 0;
  while (index < pattern.length) {
    const char = pattern.charAt(index);
    if (char === '*' && pattern.charAt(index + 1) === '*') {
      const slashed = pattern.charAt(index + 2) === '/';
      source += slashed ? '(?:.*/)?' : '.*';
      index += slashed ? 3 : 2;
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }
    source += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
    index += 1;
  }
  return new RegExp(`^${source}$`);
}

/** Does this path match any of these glob patterns? Exported for the gate-path
 * unit tests, which pin the matcher's semantics independently of git. */
export function matches_any(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => glob_to_regexp(pattern).test(path));
}

export type CollectChangesOptions = {
  /** Where the builder's effects land — the worktree under `--worktree`, else
   * the workspace (`build_root`). */
  root: string;
  /** The run's baseline commit, from `capture_baseline`. */
  baseline: string | null;
  gate_patterns: string[];
  limit?: number;
};

function by_path(left: ChangedFile, right: ChangedFile): number {
  if (left.path < right.path) return -1;
  return left.path > right.path ? 1 : 0;
}

/**
 * Everything the builder changed in `root` since `baseline`, classified against
 * the gate patterns. Tracked edits come from the diff, brand-new files from the
 * untracked list — together they cover both checkpoint styles, since `--git`
 * commits the builder's work as it goes while a plain run leaves it dirty.
 *
 * Returns null when `root` is not a git repository: the one honest answer, and
 * the signal every consumer uses to omit the section rather than claim the
 * builder changed nothing.
 */
export function collect_changes(options: CollectChangesOptions): ChangeSet | null {
  const { root, baseline } = options;
  if (!in_git_repo(root)) return null;
  const limit = options.limit ?? DEFAULT_LIMIT;

  // `--relative` + `-- .` keep both halves scoped to the build root and its own
  // path vocabulary, for the case where the workspace sits under a repo root.
  const tracked =
    baseline === null
      ? []
      : parse_name_status(
          git(root, ['diff', '--name-status', '--relative', '-z', baseline, '--', '.']).stdout,
        );
  const untracked: RawChange[] = parse_paths(
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']).stdout,
  ).map((path) => ({ path, status: 'added' }));

  const seen = new Set<string>();
  const files: ChangedFile[] = [];
  for (const change of [...tracked, ...untracked]) {
    if (excluded(change.path) || seen.has(change.path)) continue;
    seen.add(change.path);
    files.push({ ...change, gate: matches_any(change.path, options.gate_patterns) });
  }
  const sorted = files.toSorted(by_path);

  return {
    baseline,
    // Over the full list, before the cap: truncation must never hide a gate edit.
    gate_edits: sorted.filter((file) => file.gate).map((file) => file.path),
    total: sorted.length,
    files: sorted.slice(0, limit),
    truncated: sorted.length > limit,
  };
}
