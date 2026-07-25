/**
 * Git-worktree orchestration (s2 Phase 2a; D7, D13): isolate a builder run's
 * *effects* on a per-run branch checked out into a sibling worktree, then tear
 * the whole thing down when the run ends. The worktree lifecycle wraps the
 * fascicle loop — it is not itself a loop — so these are straight-line git
 * subprocess calls and the orchestrator's no-loops rule is unaffected.
 *
 * Teardown is not one behaviour but three, decided by `worktree_fate` and
 * predicted out loud by `report_worktree_fate` before any model spend: a
 * converged `--worktree --git` run *integrates* (the orchestrator squash-merges,
 * then the branch is discarded), a `--discard-worktree` run *discards*, and a
 * plain `--worktree` run *salvages* — its work was never integrated and lives
 * nowhere else, so teardown commits it onto the run branch and keeps the branch
 * instead of force-deleting the build. Everything that did not converge still
 * discards wholesale.
 */
import { existsSync, renameSync, rmSync, symlinkSync } from 'node:fs';
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

/**
 * The directory the builder's *effects* land in (s2 D3): the run's worktree
 * when `--worktree` is on, else the workspace itself. This is the containment
 * root the builder/critic file tools resolve through `contain()` and the
 * `bash` tool's cwd — re-pointing it moves writes into the worktree without
 * disturbing the workspace. `.volley/` state, the resolved config, and the
 * deterministic check stay under the workspace (the control plane), so only the
 * model-driven effect surface moves.
 */
export function build_root(workspace: string, worktree: boolean): string {
  return worktree ? worktree_path(workspace) : workspace;
}

/** What becomes of a *successful* `--worktree` run's effects (D13). Any other
 * outcome — cost cap, budget, interrupt, error — always discards: an abandoned
 * phase's branch is thrown away wholesale, as it always has been. */
export type WorktreeFate = 'none' | 'integrate' | 'salvage' | 'discard';

/** The config fields the fate turns on, as a structural subset of
 * `ResolvedConfig` so the decision is testable without a whole config. */
export type WorktreeFateConfig = {
  worktree: boolean;
  git_checkpoints: boolean;
  discard_worktree: boolean;
};

/**
 * Which of the three outcomes a converged run gets:
 *
 * - `integrate` — `--worktree --git`: the phase branch's checkpoints squash-merge
 *   onto the workspace branch (`integrate_worktree`), then teardown discards it.
 * - `discard` — `--discard-worktree`: the effects go away with the branch. What
 *   `volley matrix` sweeps with (D11): isolate the effects, keep only verdicts.
 * - `salvage` — `--worktree` alone: nothing integrates, and the worktree holds the
 *   run's only copy of its work, so teardown commits that onto the run branch and
 *   keeps it rather than force-deleting a green run's build.
 *
 * `--git` wins over `--discard-worktree`, so the documented `--worktree --git`
 * integrate path is untouched by asking for a throw-away run.
 */
export function worktree_fate(config: WorktreeFateConfig): WorktreeFate {
  if (!config.worktree) return 'none';
  if (config.git_checkpoints) return 'integrate';
  if (config.discard_worktree) return 'discard';
  return 'salvage';
}

/** The run branch as a *prediction* can name it: `--dry-run` resolves its own
 * run id, which is not the id the real run will get, so the notice names the
 * pattern and the post-run report names the branch. */
const RUN_BRANCH_PATTERN = 'volley/<run id>';

export type WorktreeNotice = { level: 'info' | 'warn'; message: string };

/**
 * What this run will do with its effects, in one line, said before any model
 * spend — the same predict-at-dry-run/warn-at-run-start shape as the local-critic
 * seat canary (D5) and the `num_ctx` guard (D12). `salvage` is a warning, not an
 * info line: `--worktree` without `--git` integrates nothing, and it is the one
 * fate an operator is likely to have configured by accident.
 */
export function worktree_notice(config: WorktreeFateConfig): WorktreeNotice | null {
  const fate = worktree_fate(config);
  if (fate === 'none') return null;
  if (fate === 'integrate') {
    return {
      level: 'info',
      message:
        'worktree: --worktree --git — a successful run squash-merges its run branch onto the ' +
        'workspace branch at teardown; any other outcome is discarded.',
    };
  }
  if (fate === 'discard') {
    return {
      level: 'info',
      message:
        'worktree: --discard-worktree — the run builds in an isolated worktree whose effects are ' +
        'thrown away at teardown, converged or not. Verdicts only; no branch is kept.',
    };
  }
  return {
    level: 'warn',
    message:
      'worktree: --worktree without --git — a successful run will NOT be integrated into the ' +
      'workspace branch, and the builder writes only inside the sibling worktree, so your working ' +
      `tree stays as it is. The run's work is committed onto its own branch (${RUN_BRANCH_PATTERN}) ` +
      'at teardown and left there for `git switch` / `git cherry-pick`. Add --git to squash-merge ' +
      'it onto the workspace branch instead, or --discard-worktree to throw it away deliberately.',
  };
}

/** The renderer channels a notice writes through — structurally satisfied by
 * `Renderer`, so this module stays independent of the render layer. */
export type NoticeSink = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

/** Emit the run's worktree fate on the channel its severity deserves (nothing at
 * all when `--worktree` is off). Called from the `--dry-run` preflight and again
 * at run start, so the outcome is predicted whether or not the operator dry-ran. */
export function report_worktree_fate(config: WorktreeFateConfig, sink: NoticeSink): void {
  const notice = worktree_notice(config);
  if (notice === null) return;
  if (notice.level === 'warn') {
    sink.warn(notice.message);
    return;
  }
  sink.info(notice.message);
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
 * idempotent trio never throws out of a run's `finally`. Still reports what it
 * can — a spawn failure reads as a non-zero exit with no output — so the salvage
 * path can interrogate the repo without reintroducing a throw. */
function git_quiet(cwd: string, args: string[]): GitResult {
  try {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch {
    // Teardown is cleanup; never mask the run's real outcome.
    return { status: -1, stdout: '', stderr: '' };
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

  // The toolchain rides along: `node_modules` is untracked, so a fresh
  // checkout has none — link the workspace's install in so the deterministic
  // check (which runs at the build root, s2 D3) and the builder's `bash` can
  // run the project toolchain without a per-run re-install.
  const modules = join(repo, 'node_modules');
  if (existsSync(modules) && !existsSync(join(path, 'node_modules'))) {
    symlinkSync(modules, join(path, 'node_modules'), 'dir');
    log(`worktree: linked node_modules from ${repo}`);
  }

  return { path, branch: options.branch };
}

/** What a teardown left behind. Both fields are null on the discarding path —
 * branch and checkout are gone, which is the point. */
export type TeardownOutcome = {
  /** The run branch teardown kept, holding work that was never integrated, for a
   * `git switch` / `git cherry-pick`. Null when the branch was deleted (nothing
   * was salvaged, or the run committed nothing worth keeping). */
  salvaged_branch: string | null;
  /** The checkout teardown refused to delete because its work could not be
   * committed (no git identity, a stale index lock, a broken repo): the files are
   * still on disk, and the next run rotates them aside rather than destroying
   * them (D7). Null whenever the checkout was removed. */
  kept_path: string | null;
};

/**
 * Tear the worktree down with the idempotent trio (D13): remove the worktree,
 * delete its branch, prune the registration. Each step tolerates the target
 * already being gone, so a second teardown — or teardown of a worktree that
 * was never created — is a safe no-op.
 *
 * `salvage` flips the trio from *discard* to *keep* for the one case that has no
 * other copy of its work: a converged run whose effects were never integrated
 * (`--worktree` without `--git` — there are no checkpoint commits and no squash
 * merge, so `branch -D` plus a `--force` removal would eat the build). Teardown
 * then commits the checkout's state onto the run branch, skips the `branch -D`,
 * and removes only the checkout. Failed and integrated runs keep discarding:
 * nothing is left to save.
 */
export function teardown_worktree(options: {
  workspace: string;
  branch: string;
  salvage?: boolean;
}): TeardownOutcome {
  const repo = resolve(options.workspace);
  const path = worktree_path(repo);
  const outcome: TeardownOutcome =
    options.salvage === true
      ? salvage_worktree(repo, path, options.branch)
      : { salvaged_branch: null, kept_path: null };
  // Salvage that could not commit: the work exists only in this directory, so
  // leave the whole worktree standing rather than removing what holds it.
  if (outcome.kept_path !== null) return outcome;

  git_quiet(repo, ['worktree', 'remove', '--force', path]);
  if (outcome.salvaged_branch === null) {
    git_quiet(repo, ['branch', '-D', options.branch]);
  }
  git_quiet(repo, ['worktree', 'prune']);
  // If git left the directory behind (already detached from the repo), clear it.
  if (existsSync(path)) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Best effort; a lingering directory does not fail the run.
    }
  }
  return outcome;
}

/**
 * Commit whatever the run left in the worktree onto the run's own branch, so an
 * unintegrated success survives its teardown. Reports the branch when it ends up
 * carrying commits the workspace branch does not — a run that changed nothing
 * leaves no branch behind — or the checkout path when the commit did not land,
 * which is teardown's signal to keep its hands off the directory.
 */
function salvage_worktree(repo: string, path: string, branch: string): TeardownOutcome {
  if (existsSync(path)) {
    git_quiet(path, ['add', '-A']);
    git_quiet(path, [
      'commit',
      '-m',
      `volley: salvage unintegrated worktree (${branch})`,
      '--no-verify',
    ]);
    if (worktree_dirty(path)) return { salvaged_branch: null, kept_path: path };
  }
  return { salvaged_branch: branch_ahead(repo, branch) ? branch : null, kept_path: null };
}

/** Uncommitted or untracked changes still in the checkout — i.e. the salvage
 * commit did not land. A git call that fails outright reads as clean: teardown's
 * existing guards already cope with a checkout git cannot speak for. */
function worktree_dirty(path: string): boolean {
  const status = git_quiet(path, ['status', '--porcelain']);
  return status.status === 0 && status.stdout.trim().length > 0;
}

/** Does `branch` carry commits the workspace's HEAD does not? The run branch is
 * cut from HEAD, so this asks "did the run commit anything?" — and answers false
 * for a branch that does not exist, which keeps teardown idempotent. */
function branch_ahead(repo: string, branch: string): boolean {
  const ahead = git_quiet(repo, ['rev-list', '--count', `HEAD..${branch}`]);
  return ahead.status === 0 && Number(ahead.stdout.trim()) > 0;
}

export type WorktreeOptions<T> = {
  enabled: boolean;
  workspace: string;
  branch: string;
  log?: (message: string) => void;
  /** Consulted with the body's value on a clean exit: `true` means this run's
   * work was never integrated, so teardown must salvage it onto the run branch
   * instead of discarding it (D13). Never consulted when the body throws — a
   * failed run's branch is thrown away wholesale. */
  salvage?: (value: T) => boolean;
};

/** The body's value plus what teardown left behind. */
export type WorktreeOutcome<T> = TeardownOutcome & { value: T };

/**
 * Run `body` with the run's worktree lifecycle around it: when enabled, create
 * the worktree first and guarantee teardown on every exit path; when disabled,
 * this is a transparent pass-through so the default path is byte-for-byte
 * unchanged.
 *
 * The discarding teardown stays in the `finally` — it is what a throw, an abort,
 * or a non-salvaging exit gets. A *salvaging* teardown has to run inside the
 * `try` instead, because its outcome (the surviving branch) is part of this
 * call's return value; `discard_on_exit` hands the responsibility over so the
 * two never both fire and `branch -D` the branch salvage just kept.
 */
export async function with_worktree<T>(
  options: WorktreeOptions<T>,
  body: () => Promise<T>,
): Promise<WorktreeOutcome<T>> {
  if (!options.enabled) {
    return { value: await body(), salvaged_branch: null, kept_path: null };
  }
  create_worktree({
    workspace: options.workspace,
    branch: options.branch,
    ...(options.log !== undefined ? { log: options.log } : {}),
  });
  let discard_on_exit = true;
  try {
    const value = await body();
    if (options.salvage?.(value) !== true) {
      return { value, salvaged_branch: null, kept_path: null };
    }
    discard_on_exit = false;
    return {
      value,
      ...teardown_worktree({
        workspace: options.workspace,
        branch: options.branch,
        salvage: true,
      }),
    };
  } finally {
    if (discard_on_exit) {
      teardown_worktree({ workspace: options.workspace, branch: options.branch });
    }
  }
}
