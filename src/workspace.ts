/**
 * Workspace lifecycle: run-state initialization, stale-run
 * backup rotation, path helpers, and optional git checkpoints.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { check_error, config_error } from './types.js';
import type { ResolvedConfig } from './types.js';

/** What locates a run's state, as a structural subset of `ResolvedConfig` so a
 * resume can find a run before it has a whole config. */
export type StateLocation = Pick<ResolvedConfig, 'workspace' | 'state_dir' | 'run_id'>;

/** Where a run keeps its config, summary, trajectory, feedback, verdict, and
 * iterations: `<state_dir>/<run_id>/` under a state root, else
 * `<workspace>/.volley/`. */
export function run_state_dir(run: StateLocation): string {
  return run.state_dir === null ? join(run.workspace, '.volley') : join(run.state_dir, run.run_id);
}

export function state_path(run: StateLocation, ...parts: string[]): string {
  return join(run_state_dir(run), ...parts);
}

export function iteration_dir(run: StateLocation, iteration: number): string {
  return state_path(run, 'iterations', String(iteration).padStart(3, '0'));
}

/** Filesystem-safe timestamp for `.bak.<stamp>` rotation names. Shared by the
 * run-state rotation here and the worktree rotation so both preserve
 * prior state under the same never-destroy naming. */
export function backup_stamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** Fresh-run initialization: rotate a stale state directory aside (a prior
 * `.volley/` becomes `.volley.bak.<stamp>`), then create the directory tree.
 * Under a state root each run has a directory of its own, so only a reused
 * `--run-id` ever finds one to rotate. Resume runs skip rotation
 * (`preserve: true`). */
export function initialize_run_state(
  run: StateLocation,
  options: { preserve?: boolean } = {},
): void {
  const dir = run_state_dir(run);
  if (existsSync(dir) && options.preserve !== true) {
    renameSync(dir, `${dir}.bak.${backup_stamp()}`);
  }
  mkdirSync(join(dir, 'iterations'), { recursive: true });
}

export function write_resolved_config(config: ResolvedConfig): void {
  const record = {
    version: config.version,
    run_id: config.run_id,
    started_at: config.started_at,
    prompt: config.prompt,
    criteria: config.criteria,
    check: config.check,
    check_resolved: config.check_resolved,
    builder_model: config.builder_model,
    builder_provider: config.builder_provider,
    builder_url: config.builder_url,
    builder_max_steps: config.builder_max_steps,
    critic_model: config.critic_model,
    critic_provider: config.critic_provider,
    critic_url: config.critic_url,
    builder_permission_mode: config.builder_permission_mode,
    critic_preset: config.critic_preset,
    critic_prompt_path: config.critic_prompt_path,
    max_iterations: config.max_iterations,
    max_cost_usd: config.max_cost_usd,
    git_checkpoints: config.git_checkpoints,
    worktree: config.worktree,
    discard_worktree: config.discard_worktree,
    gate_paths: config.gate_paths,
    fail_on_gate_edit: config.fail_on_gate_edit,
    sandbox_image: config.sandbox_image,
    state_dir: config.state_dir,
    workspace: config.workspace,
  };
  writeFileSync(
    state_path(config, 'config.json'),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

/**
 * `--git`: commit everything under `root` after a phase (`git -C <root>`, run
 * here via the spawn `cwd`). `root` is the build root (`build_root`): the
 * workspace on the default path, or the per-run worktree under `--worktree`, so
 * checkpoints land on the worktree branch rather than the workspace's.
 * A checkpoint with nothing to commit is fine; a missing git binary or repo is
 * not.
 */
export function git_checkpoint(root: string, message: string): void {
  if (!existsSync(join(root, '.git'))) {
    // `.git` is a directory in the workspace and a file in a linked worktree;
    // existsSync accepts both.
    throw config_error(`git checkpoints require a git repository: ${root}`);
  }
  const add = spawnSync('git', ['add', '-A'], { cwd: root });
  if (add.error !== undefined || add.status !== 0) {
    throw check_error(`git add failed: ${add.stderr?.toString() ?? String(add.error)}`);
  }
  const commit = spawnSync('git', ['commit', '-m', message, '--no-verify'], {
    cwd: root,
  });
  // Exit 1 with "nothing to commit" is a no-op iteration, not a failure.
  if (commit.error !== undefined) {
    throw check_error(`git commit failed to start: ${String(commit.error)}`);
  }
  const out = `${commit.stdout?.toString() ?? ''}${commit.stderr?.toString() ?? ''}`;
  if (commit.status !== 0 && !out.includes('nothing to commit')) {
    throw check_error(`git commit failed: ${out.trim()}`);
  }
}

/**
 * Integration — bring a successful `--worktree --git` run's effects onto the
 * workspace branch. The per-phase checkpoints on `branch` are the raw
 * audit/replay trail; here they collapse into a single squash commit
 * (`git merge --squash` then `commit`) on the workspace's current branch. The
 * shared object store makes this a local, fetch-free merge, and — because the
 * workspace branch never moved during the run (checkpoints went to the phase
 * branch) — it is conflict-free by construction. A run whose phase branch has no
 * new commits integrates to a no-op. Only successful runs integrate; an
 * abandoned run's branch is discarded wholesale by the teardown trio instead.
 */
export function integrate_worktree(workspace: string, branch: string, message: string): void {
  if (!existsSync(join(workspace, '.git'))) {
    throw config_error(`--worktree integration requires a git repository: ${workspace}`);
  }
  const squash = spawnSync('git', ['merge', '--squash', branch], {
    cwd: workspace,
    encoding: 'utf8',
  });
  if (squash.error !== undefined) {
    throw check_error(`git merge --squash failed to start: ${String(squash.error)}`);
  }
  if (squash.status !== 0) {
    throw check_error(
      `git merge --squash ${branch} failed: ${(squash.stderr || squash.stdout).trim()}`,
    );
  }
  const commit = spawnSync('git', ['commit', '-m', message, '--no-verify'], {
    cwd: workspace,
    encoding: 'utf8',
  });
  if (commit.error !== undefined) {
    throw check_error(`git commit failed to start: ${String(commit.error)}`);
  }
  // An empty phase branch stages nothing; "nothing to commit" is a no-op.
  const out = `${commit.stdout ?? ''}${commit.stderr ?? ''}`;
  if (commit.status !== 0 && !out.includes('nothing to commit')) {
    throw check_error(`git commit failed: ${out.trim()}`);
  }
}
