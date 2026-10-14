/**
 * The Claude builder's effects must land where every other phase looks: the
 * build root. Every other integration test injects a mock engine, which never
 * reaches `create_volley_engine`, so this one drives the real engine against a
 * stand-in `claude` binary (`VOLLEY_CLAUDE_BIN`) and checks where its writes go.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run_volley } from '../../src/orchestrator.js';
import { worktree_branch } from '../../src/worktree.js';
import { silent_renderer, temp_git_workspace, test_config } from '../helpers/harness.js';

const MARKER = 'claude-was-here.txt';

/** As the builder, it drops MARKER into its working directory; as the critic
 * (`--json-schema` in its argv), it approves. Either way it speaks just enough
 * stream-json for fascicle's `claude_cli` adapter: an init event, then a result. */
const FAKE_CLAUDE = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const is_critic = process.argv.includes('--json-schema');
if (!is_critic) writeFileSync('${MARKER}', 'written by the fake builder\\n');
const result = is_critic
  ? JSON.stringify({ verdict: 'approved', feedback: 'looks done', unmet_criteria: [] })
  : 'wrote the marker';
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
emit({ type: 'system', subtype: 'init', session_id: 'fake-session', model: 'fake-model' });
emit({
  type: 'result',
  subtype: 'success',
  session_id: 'fake-session',
  duration_ms: 1,
  total_cost_usd: 0,
  is_error: false,
  usage: { input_tokens: 0, output_tokens: 0 },
  result,
});
`;

function install_fake_claude(): { bin: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'volley-fake-claude-'));
  const bin = join(dir, 'claude.mjs');
  writeFileSync(bin, FAKE_CLAUDE);
  chmodSync(bin, 0o755);
  return { bin, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('claude_cli builder under --worktree', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('runs the Claude session in the worktree, not the workspace', async () => {
    const { workspace, cleanup } = temp_git_workspace();
    const fake = install_fake_claude();
    try {
      vi.stubEnv('VOLLEY_CLAUDE_BIN', fake.bin);
      vi.stubEnv('VOLLEY_AUTH_MODE', 'auto');
      const config = test_config({ workspace, worktree: true });

      const result = await run_volley(config, {
        renderer: silent_renderer(),
        install_signal_handlers: false,
      });

      expect(result.status).toBe('success');
      // The builder never wrote into the operator's checkout...
      expect(existsSync(join(workspace, MARKER))).toBe(false);
      // ...it wrote into the worktree, which a plain --worktree run salvages onto
      // its run branch at teardown.
      const branch = worktree_branch(config.run_id);
      expect(result.salvaged_branch).toBe(branch);
      const shown = spawnSync('git', ['show', `${branch}:${MARKER}`], {
        cwd: workspace,
        encoding: 'utf8',
      });
      expect(shown.status).toBe(0);
      expect(shown.stdout).toContain('written by the fake builder');
    } finally {
      fake.remove();
      cleanup();
    }
  });
});
