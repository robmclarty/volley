/**
 * Git-worktree orchestration (s2 Phase 2a; D7, D13): isolate a builder run's
 * *effects* on a per-run branch checked out into a sibling worktree, then tear
 * the whole thing down when the run ends. The worktree lifecycle wraps the
 * fascicle loop — it is not itself a loop — so these are straight-line git
 * subprocess calls and the orchestrator's no-loops rule is unaffected.
 *
 * `contain()` still points at the workspace here; re-pointing the builder's
 * write root at the worktree, and taking checkpoints on its branch, land in
 * later steps. This module owns the create / rotate / teardown mechanics they
 * build on.
 */
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { check_error, config_error } from './types.js';
import { backup_stamp } from './workspace.js';

/** A live worktree: the checked-out path and the branch it holds. */
export type WorktreeHandle = {
  path: string;
  branch: string;
};

/** The sibling directory a run's worktree is checked out into — one per
 * workspace, alongside it so it never nests inside the repo's own tree. */
export function worktree_path(workspace: string): string {
  return `${resolve(workspace)}.worktree`;
}

/** The per-run branch name (D13: one named branch per phase). Derived from the
 * run id so it is stable across a resume. */
export function worktree_branch(run_id: string): string {
  return `volley/${run_id}`;
}

type GitResult = { status: number; stdout: string; stderr: string };

/** Run git in `cwd`. A missing git binary is a precondition failure (like the
 * missing-repo guard); a non-zero exit is left to the caller to interpret. */
function git(cwd: string, args: string[]): GitResult {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error !== undefined) {
    throw config_error(`git is required for --worktree but could not run: ${String(result.error)}`);
  }
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Run git and throw on a non-zero exit, surfacing git's own diagnostics. */
function git_ok(cwd: string, args: string[]): GitResult {
  const result = git(cwd, args);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw check_error(`git ${args.join(' ')} failed: ${detail}`);
  }
  return result;
}

/** Best-effort git for teardown: swallows both spawn and exit failures so the
 * idempotent trio never throws out of a run's `finally`. */
function git_quiet(cwd: string, args: string[]): void {
  try {
    spawnSync('git', args, { cwd, encoding: 'utf8' });
  } catch {
    // Teardown is cleanup; never mask the run's real outcome.
  }
}

function branch_exists(repo: string, branch: string): boolean {
  return git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
}

/**
 * Check `branch` out into a fresh worktree at `worktree_path(workspace)`.
 *
 * Rotate-on-conflict (D7): a leftover worktree directory or branch from a
 * crashed run is renamed aside under a `.bak.<stamp>` name — never destroyed —
 * before the fresh one is created, mirroring `.volley.bak.<stamp>`.
 */
export function create_worktree(options: {
  workspace: string;
  branch: string;
  base?: string;
  log?: (message: string) => void;
}): WorktreeHandle {
  const repo = resolve(options.workspace);
  if (!existsSync(join(repo, '.git'))) {
    throw config_error(`--worktree requires the workspace to be a git repository: ${repo}`);
  }
  const path = worktree_path(repo);
  const base = options.base ?? 'HEAD';
  const log = options.log ?? (() => {});

  // Preserve a leftover directory (possibly dirty), then drop its now-dangling
  // registration so `worktree add` sees a clean slate.
  if (existsSync(path)) {
    const backup = `${path}.bak.${backup_stamp()}`;
    renameSync(path, backup);
    git(repo, ['worktree', 'prune']);
    log(`worktree: rotated existing ${path} aside to ${backup}`);
  }
  // Preserve a leftover branch's commits rather than clobbering with `-B`.
  if (branch_exists(repo, options.branch)) {
    const backup_branch = `${options.branch}.bak.${backup_stamp()}`;
    git_ok(repo, ['branch', '-m', options.branch, backup_branch]);
    log(`worktree: rotated existing branch ${options.branch} aside to ${backup_branch}`);
  }

  git_ok(repo, ['worktree', 'add', '-b', options.branch, path, base]);
  return { path, branch: options.branch };
}

/**
 * Tear the worktree down with the idempotent trio (D13): remove the worktree,
 * delete its branch, prune the registration. Each step tolerates the target
 * already being gone, so a second teardown — or teardown of a worktree that
 * was never created — is a safe no-op.
 */
export function teardown_worktree(options: { workspace: string; branch: string }): void {
  const repo = resolve(options.workspace);
  const path = worktree_path(repo);
  git_quiet(repo, ['worktree', 'remove', '--force', path]);
  git_quiet(repo, ['branch', '-D', options.branch]);
  git_quiet(repo, ['worktree', 'prune']);
  // If git left the directory behind (already detached from the repo), clear it.
  if (existsSync(path)) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Best effort; a lingering directory does not fail the run.
    }
  }
}

export type WorktreeOptions = {
  enabled: boolean;
  workspace: string;
  branch: string;
  log?: (message: string) => void;
};

/**
 * Run `body` with the run's worktree lifecycle around it: when enabled, create
 * the worktree first and guarantee teardown in a `finally`; when disabled, this
 * is a transparent pass-through so the default path is byte-for-byte unchanged.
 */
export async function with_worktree<T>(
  options: WorktreeOptions,
  body: () => Promise<T>,
): Promise<T> {
  if (!options.enabled) {
    return body();
  }
  create_worktree({
    workspace: options.workspace,
    branch: options.branch,
    ...(options.log !== undefined ? { log: options.log } : {}),
  });
  try {
    return await body();
  } finally {
    teardown_worktree({ workspace: options.workspace, branch: options.branch });
  }
}
