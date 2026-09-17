import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run_volley } from '../../src/orchestrator.js';
import { exit_code_for_status } from '../../src/exit_codes.js';
import { silent_renderer, temp_workspace, test_config } from '../helpers/harness.js';
import { approve_reply, mock_engine, prompt_text } from '../helpers/mock_engine.js';

describe('fresh_workspace_happy_path', () => {
  it('builder writes the file, check passes, critic approves -> success', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({
        workspace,
        check: 'test -f done.txt',
        check_resolved: 'command',
        max_cost_usd: 20,
      });
      const engine = mock_engine((call) =>
        call.role === 'builder'
          ? {
              content: 'wrote the file',
              cost_usd: 0.25,
              effect: () => writeFileSync(join(workspace, 'done.txt'), 'done\n'),
            }
          : approve_reply('All criteria met.'),
      );

      const result = await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });

      expect(result.status).toBe('success');
      expect(exit_code_for_status(result.status)).toBe(0);
      expect(result.iterations_completed).toBe(1);
      expect(result.final_verdict).toBe('approved');
      expect(result.total_cost_usd).toBeCloseTo(0.3);
      expect(result.total_usage.input_tokens).toBeGreaterThan(0);

      // .volley/ layout.
      expect(existsSync(join(workspace, '.volley', 'config.json'))).toBe(true);
      expect(existsSync(join(workspace, '.volley', 'trajectory.jsonl'))).toBe(true);
      expect(readFileSync(join(workspace, '.volley', 'verdict'), 'utf8')).toBe('approved\n');
      expect(readFileSync(join(workspace, '.volley', 'feedback.md'), 'utf8')).toContain(
        'All criteria met.',
      );

      const iteration_summary = JSON.parse(
        readFileSync(join(workspace, '.volley', 'iterations', '001', 'summary.json'), 'utf8'),
      );
      expect(iteration_summary.iteration).toBe(1);
      expect(iteration_summary.verdict).toBe('approved');
      expect(iteration_summary.builder.cost_source).toBe('provider_reported');
      expect(iteration_summary.check.ok).toBe(true);
      expect(iteration_summary.iteration_cost_usd).toBeCloseTo(0.3);

      const run_summary = JSON.parse(
        readFileSync(join(workspace, '.volley', 'summary.json'), 'utf8'),
      );
      expect(run_summary.status).toBe('success');
      expect(run_summary.completed_at).not.toBeNull();

      // Trajectory is valid line-delimited JSON.
      const lines = readFileSync(join(workspace, '.volley', 'trajectory.jsonl'), 'utf8')
        .trim()
        .split('\n');
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) JSON.parse(line);
    } finally {
      cleanup();
    }
  });

  it('feeds critic feedback into the next builder prompt', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({ workspace, max_iterations: 3 });
      const engine = mock_engine((call, index) => {
        if (call.role === 'builder') return { content: 'built', cost_usd: 0.1 };
        return index < 2
          ? { content: { verdict: 'changes_requested', feedback: 'FIX THE SPINNER', unmet_criteria: ['spins'] }, cost_usd: 0.05 }
          : approve_reply();
      });

      const result = await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });

      expect(result.status).toBe('success');
      expect(result.iterations_completed).toBe(2);
      const second_builder = engine.calls.filter((c) => c.role === 'builder')[1];
      expect(prompt_text(second_builder)).toContain('FIX THE SPINNER');
      expect(prompt_text(second_builder)).toContain('ITERATION: 2');
    } finally {
      cleanup();
    }
  });

  it('rotates a stale .volley/ directory on a fresh run', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({ workspace });
      const engine = mock_engine((call) =>
        call.role === 'builder' ? { content: 'ok', cost_usd: 0.1 } : approve_reply(),
      );
      await run_volley(config, { renderer: silent_renderer(), engine, install_signal_handlers: false });
      await run_volley(config, { renderer: silent_renderer(), engine, install_signal_handlers: false });
      const { readdirSync } = await import('node:fs');
      const backups = readdirSync(workspace).filter((f) => f.startsWith('.volley.bak.'));
      expect(backups).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});
