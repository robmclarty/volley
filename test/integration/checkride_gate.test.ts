import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run_volley } from '../../src/orchestrator.js';
import { silent_renderer, temp_workspace, test_config } from '../helpers/harness.js';
import { approve_reply, mock_engine, prompt_text, reject_reply } from '../helpers/mock_engine.js';

/** A stand-in checkride binary honoring the `--json` + `.check/summary.json`
 * contract: fails the `test` slot while BROKEN exists in the workspace. */
const FAKE_CHECKRIDE = `#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const broken = existsSync('BROKEN');
mkdirSync('.check', { recursive: true });
const checks = [{
  name: 'test', adapter: 'vitest', description: 'tests',
  ok: !broken, exit_code: broken ? 1 : 0, duration_ms: 42, output_file: 'test.json',
}];
const summary = { schema_version: 1, timestamp: new Date().toISOString(), ok: !broken, total_duration_ms: 42, checks };
writeFileSync('.check/summary.json', JSON.stringify(summary, null, 2));
writeFileSync('.check/test.json', JSON.stringify({ failed: broken ? 1 : 0, failing_test: broken ? 'widget spins' : null }));
process.stdout.write(JSON.stringify(summary));
process.exit(broken ? 1 : 0);
`;

function setup_checkride_workspace(workspace: string): void {
  writeFileSync(
    join(workspace, 'package.json'),
    JSON.stringify({ name: 'fixture', type: 'module', scripts: { check: 'checkride' } }),
  );
  writeFileSync(join(workspace, 'checkride.config.json'), '{}');
  const bin_dir = join(workspace, 'node_modules', '.bin');
  mkdirSync(bin_dir, { recursive: true });
  const bin = join(bin_dir, 'checkride');
  writeFileSync(bin, FAKE_CHECKRIDE);
  chmodSync(bin, 0o755);
  writeFileSync(join(workspace, 'BROKEN'), 'the test slot fails while this exists\n');
}

describe('checkride_gate_loop', () => {
  it('iteration 1 fails the gate, critic sees the raw slot, iteration 2 passes', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      setup_checkride_workspace(workspace);
      const config = test_config({
        workspace,
        check: 'auto',
        check_resolved: 'checkride',
        max_iterations: 4,
      });

      const engine = mock_engine((call) => {
        if (call.role === 'builder') {
          const fix = prompt_text(call).includes('PREVIOUS CRITIC FEEDBACK');
          return {
            content: fix ? 'fixed the test' : 'first attempt',
            cost_usd: 0.1,
            effect: () => {
              if (fix) rmSync(join(workspace, 'BROKEN'), { force: true });
            },
          };
        }
        const failing = prompt_text(call).includes('FAILED');
        return failing ? reject_reply('the test slot fails', ['tests pass']) : approve_reply();
      });

      const result = await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });

      expect(result.status).toBe('success');
      expect(result.iterations_completed).toBe(2);

      // The builder prompt carried the checkride self-verify stanza.
      const first_builder = engine.calls.find((c) => c.role === 'builder');
      expect(prompt_text(first_builder)).toContain('pnpm check');

      // Critic 1 received the failing slot's raw artifact, not a digest.
      const first_critic = engine.calls.find((c) => c.role === 'critic');
      expect(prompt_text(first_critic)).toContain('failing slots: test');
      expect(prompt_text(first_critic)).toContain('widget spins');

      // Archived check artifacts for the failing iteration (spec §3).
      const archive = join(workspace, '.volley', 'iterations', '001', 'check');
      expect(existsSync(join(archive, 'summary.json'))).toBe(true);
      expect(existsSync(join(archive, 'test.json'))).toBe(true);

      const iteration_1 = JSON.parse(
        readFileSync(join(workspace, '.volley', 'iterations', '001', 'summary.json'), 'utf8'),
      ) as { check: { ok: boolean; failing_slots: string[]; runner: string } };
      expect(iteration_1.check.ok).toBe(false);
      expect(iteration_1.check.runner).toBe('checkride');
      expect(iteration_1.check.failing_slots).toEqual(['test']);
    } finally {
      cleanup();
    }
  }, 60000);
});
