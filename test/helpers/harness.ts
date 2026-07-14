/**
 * Shared integration-test scaffolding: temp workspaces, a silent renderer,
 * and a ResolvedConfig factory.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { create_renderer } from '../../src/render/renderer.js';
import type { Renderer } from '../../src/render/renderer.js';
import type { ResolvedConfig } from '../../src/types.js';

export function temp_workspace(): { workspace: string; cleanup: () => void } {
  const workspace = mkdtempSync(join(tmpdir(), 'volley-test-'));
  return {
    workspace,
    cleanup: () => {
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}

/** A temp workspace that is a git repo with one commit (so `HEAD` resolves),
 * for exercising the worktree lifecycle. Cleanup also removes the sibling
 * `.worktree` directory the worktree module checks out alongside it. */
export function temp_git_workspace(): { workspace: string; cleanup: () => void } {
  const { workspace, cleanup } = temp_workspace();
  const git = (args: string[]): void => {
    const r = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'test@volley.local']);
  git(['config', 'user.name', 'Volley Test']);
  git(['commit', '-q', '--allow-empty', '-m', 'root']);
  return {
    workspace,
    cleanup: () => {
      // Sweep the sibling worktree and any rotated-aside `.worktree.bak.*`.
      const parent = dirname(workspace);
      const prefix = `${basename(workspace)}.worktree`;
      for (const entry of readdirSync(parent)) {
        if (entry.startsWith(prefix)) rmSync(join(parent, entry), { recursive: true, force: true });
      }
      cleanup();
    },
  };
}

export function silent_renderer(): Renderer {
  return create_renderer({
    mode: 'json',
    show_thinking: false,
    color: false,
    max_cost_usd: null,
    write: () => {},
  });
}

export function test_config(overrides: Partial<ResolvedConfig> & { workspace: string }): ResolvedConfig {
  return {
    version: 2,
    run_id: 'test-run-id',
    started_at: new Date().toISOString(),
    prompt: 'write the file',
    criteria: 'the file exists',
    check: 'none',
    check_resolved: 'none',
    builder_model: 'opus',
    builder_provider: 'claude_cli',
    builder_max_steps: 50,
    allow_unsandboxed_builder: false,
    critic_model: 'opus',
    critic_provider: 'claude_cli',
    builder_permission_mode: 'acceptEdits',
    critic_preset: 'reviewer',
    critic_prompt_path: null,
    max_iterations: 10,
    max_cost_usd: null,
    git_checkpoints: false,
    verbose: false,
    quiet: false,
    json: true,
    show_thinking: false,
    ...overrides,
  };
}

export function write_file(workspace: string, name: string, content: string): void {
  writeFileSync(join(workspace, name), content);
}
