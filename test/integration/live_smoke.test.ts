/**
 * Opt-in live tests (spec §10): VOLLEY_LIVE=1 pnpm test
 *
 * live_smoke drives the real `claude` CLI once; live_checkride_smoke runs the
 * real checkride binary against a minimal fixture workspace. Both are skipped
 * by default — they cost money and/or require local tooling.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { run_checkride } from '../../src/check/checkride.js';
import { create_volley_engine } from '../../src/engine.js';
import { run_volley } from '../../src/orchestrator.js';
import { silent_renderer, temp_workspace, test_config } from '../helpers/harness.js';

const LIVE = process.env['VOLLEY_LIVE'] === '1';

describe.runIf(LIVE)('live_smoke (real claude CLI)', () => {
  it('one-iteration run wires argv, schema output, and cost end to end', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({
        workspace,
        prompt: 'Create a file named hello.txt containing exactly: hello volley',
        criteria: 'hello.txt exists and contains "hello volley"',
        builder_model: 'haiku',
        critic_model: 'haiku',
        max_iterations: 1,
        max_cost_usd: 2,
      });
      const engine = create_volley_engine({ workspace });
      const result = await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });
      // One iteration may or may not satisfy the critic; both are valid runs.
      expect(['success', 'budget_exhausted']).toContain(result.status);
      expect(result.iterations_completed).toBe(1);
      expect(result.total_cost_usd).toBeGreaterThan(0);
      expect(existsSync(join(workspace, 'hello.txt'))).toBe(true);
      expect(existsSync(join(workspace, '.volley', 'trajectory.jsonl'))).toBe(true);
    } finally {
      cleanup();
    }
  }, 600000);
});

describe.runIf(LIVE)('live_checkride_smoke (real checkride)', () => {
  it('parses the real --json summary against schema_version 1', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      // Minimal pnpm-style workspace: a shim to the repo's own pinned
      // checkride, plus one config-only custom check that always passes.
      const repo_root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
      const checkride_cli = join(repo_root, 'node_modules', 'checkride', 'dist', 'cli.js');
      writeFileSync(
        join(workspace, 'package.json'),
        JSON.stringify({ name: 'live-fixture', type: 'module' }),
      );
      writeFileSync(
        join(workspace, 'checkride.config.json'),
        JSON.stringify({ checks: { smoke: { command: 'true', description: 'always green' } } }),
      );
      const bin_dir = join(workspace, 'node_modules', '.bin');
      mkdirSync(bin_dir, { recursive: true });
      const bin = join(bin_dir, 'checkride');
      writeFileSync(bin, `#!/bin/sh\nexec node "${checkride_cli}" "$@"\n`);
      chmodSync(bin, 0o755);

      const result = await run_checkride({ workspace });
      expect(result.ran).toBe(true);
      expect(result.runner).toBe('checkride');
      expect(result.ok).toBe(true);
      expect((result.summary as { schema_version: number }).schema_version).toBe(1);
      expect(existsSync(join(workspace, '.check', 'summary.json'))).toBe(true);
    } finally {
      cleanup();
    }
  }, 120000);
});
