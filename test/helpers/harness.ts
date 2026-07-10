/**
 * Shared integration-test scaffolding: temp workspaces, a silent renderer,
 * and a ResolvedConfig factory.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
