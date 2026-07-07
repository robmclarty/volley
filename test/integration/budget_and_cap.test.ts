import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run_volley } from '../../src/orchestrator.js';
import { exit_code_for_status } from '../../src/exit_codes.js';
import { silent_renderer, temp_workspace, test_config } from '../helpers/harness.js';
import { mock_engine, reject_reply } from '../helpers/mock_engine.js';

describe('budget_exhaustion', () => {
  it('critic never approves -> exit 2 after max iterations', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({ workspace, max_iterations: 2 });
      const engine = mock_engine((call) =>
        call.role === 'builder'
          ? { content: 'tried', cost_usd: 0.1 }
          : reject_reply('still wrong', ['works']),
      );
      const result = await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });
      expect(result.status).toBe('budget_exhausted');
      expect(exit_code_for_status(result.status)).toBe(2);
      expect(result.iterations_completed).toBe(2);
      expect(result.final_verdict).toBe('changes_requested');
      expect(existsSync(join(workspace, '.volley', 'iterations', '002', 'summary.json'))).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe('cost_cap', () => {
  it('builder crossing the cap skips check and critic -> exit 7', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({
        workspace,
        max_cost_usd: 0.5,
        check: 'true',
        check_resolved: 'command',
      });
      const engine = mock_engine((call) =>
        call.role === 'builder'
          ? { content: 'expensive work', cost_usd: 0.6 }
          : reject_reply('should never be called'),
      );
      const result = await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });
      expect(result.status).toBe('cost_cap_reached');
      expect(exit_code_for_status(result.status)).toBe(7);
      expect(result.iterations_completed).toBe(1);
      // No critic spend after the builder alone crossed the cap (spec §6).
      expect(engine.calls.filter((c) => c.role === 'critic')).toHaveLength(0);
      const summary = JSON.parse(
        readFileSync(join(workspace, '.volley', 'summary.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(summary['status']).toBe('cost_cap_reached');
      expect(summary['final_verdict']).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('cap crossing after the critic stops the loop with the iteration intact', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({ workspace, max_cost_usd: 0.3, max_iterations: 5 });
      const engine = mock_engine((call) =>
        call.role === 'builder'
          ? { content: 'work', cost_usd: 0.2 }
          : reject_reply('not yet'),
      );
      const result = await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });
      expect(result.status).toBe('cost_cap_reached');
      expect(result.iterations_completed).toBe(2);
      expect(result.total_cost_usd).toBeGreaterThanOrEqual(0.3);
    } finally {
      cleanup();
    }
  });
});
