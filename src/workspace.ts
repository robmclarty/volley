/**
 * Workspace lifecycle (spec §3, §9 #17): `.volley/` initialization, stale-run
 * backup rotation, path helpers, and optional git checkpoints.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { check_error, config_error } from './types.js';
import type { ResolvedConfig } from './types.js';

export function volley_path(workspace: string, ...parts: string[]): string {
  return join(workspace, '.volley', ...parts);
}

export function iteration_dir(workspace: string, iteration: number): string {
  return volley_path(workspace, 'iterations', String(iteration).padStart(3, '0'));
}

/** Fresh-run initialization: rotate a stale `.volley/` aside, then create the
 * directory tree. Resume runs skip rotation (`preserve: true`). */
export function initialize_workspace(
  workspace: string,
  options: { preserve?: boolean } = {},
): void {
  const dir = volley_path(workspace);
  if (existsSync(dir) && options.preserve !== true) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    renameSync(dir, join(workspace, `.volley.bak.${stamp}`));
  }
  mkdirSync(volley_path(workspace, 'iterations'), { recursive: true });
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
    builder_max_steps: config.builder_max_steps,
    critic_model: config.critic_model,
    critic_provider: config.critic_provider,
    builder_permission_mode: config.builder_permission_mode,
    critic_preset: config.critic_preset,
    critic_prompt_path: config.critic_prompt_path,
    max_iterations: config.max_iterations,
    max_cost_usd: config.max_cost_usd,
    git_checkpoints: config.git_checkpoints,
    workspace: config.workspace,
  };
  writeFileSync(
    volley_path(config.workspace, 'config.json'),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

/** `--git`: commit the whole workspace after a phase. A checkpoint with
 * nothing to commit is fine; a missing git binary or repo is not. */
export function git_checkpoint(workspace: string, message: string): void {
  if (!existsSync(join(workspace, '.git'))) {
    throw config_error(`--git requires the workspace to be a git repository: ${workspace}`);
  }
  const add = spawnSync('git', ['add', '-A'], { cwd: workspace });
  if (add.error !== undefined || add.status !== 0) {
    throw check_error(`git add failed: ${add.stderr?.toString() ?? String(add.error)}`);
  }
  const commit = spawnSync('git', ['commit', '-m', message, '--no-verify'], {
    cwd: workspace,
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
