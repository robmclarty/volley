import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aborted_error } from 'fascicle';
import { load_resume_state } from '../../src/iteration.js';
import { run_volley } from '../../src/orchestrator.js';
import { exit_code_for_error } from '../../src/exit_codes.js';
import { error_kind } from '../../src/types.js';
import { initialize_workspace, volley_path, write_resolved_config } from '../../src/workspace.js';
import { silent_renderer, temp_workspace, test_config } from '../helpers/harness.js';
import { approve_reply, mock_engine, prompt_text, reject_reply } from '../helpers/mock_engine.js';

describe('resume', () => {
  it('continues after an interrupted iteration with feedback and totals carried', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({ workspace, run_id: 'resumable-run', max_iterations: 5 });

      // Run 1: iteration 1 completes (changes requested); iteration 2's
      // builder dies on SIGINT (aborted_error) mid-phase.
      const engine_1 = mock_engine((call, index) => {
        if (call.role === 'critic') return reject_reply('needs the spinner fixed');
        return index === 0
          ? { content: 'first pass', cost_usd: 0.2 }
          : { content: '', error: new aborted_error('sigint') };
      });
      let thrown: unknown = null;
      try {
        await run_volley(config, {
          renderer: silent_renderer(),
          engine: engine_1,
          install_signal_handlers: false,
        });
      } catch (err) {
        thrown = err;
      }
      expect(error_kind(thrown)).toBe('phase_error');
      expect(exit_code_for_error(thrown)).toBe(130);

      const interrupted_summary = JSON.parse(
        readFileSync(join(workspace, '.volley', 'summary.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(interrupted_summary['status']).toBe('interrupted');

      // Trajectory has no torn tail — every line parses.
      const lines = readFileSync(join(workspace, '.volley', 'trajectory.jsonl'), 'utf8')
        .trim()
        .split('\n');
      for (const line of lines) JSON.parse(line);

      // Resume: recovers iteration 1's state, continues at iteration 2.
      const resume = load_resume_state(workspace, 'resumable-run');
      expect(resume.iterations_completed).toBe(1);
      expect(resume.state.feedback).toContain('needs the spinner fixed');
      expect(resume.state.total_cost_usd).toBeCloseTo(0.25);

      const engine_2 = mock_engine((call) =>
        call.role === 'builder' ? { content: 'fixed it', cost_usd: 0.2 } : approve_reply(),
      );
      const result = await run_volley(
        config,
        { renderer: silent_renderer(), engine: engine_2, install_signal_handlers: false },
        resume.state,
      );

      expect(result.status).toBe('success');
      expect(result.iterations_completed).toBe(2);
      // Totals accumulate across the interruption.
      expect(result.total_cost_usd).toBeCloseTo(0.5);

      // The resumed builder saw iteration 1's feedback.
      const builder_call = engine_2.calls.find((c) => c.role === 'builder');
      expect(prompt_text(builder_call)).toContain('needs the spinner fixed');
      expect(prompt_text(builder_call)).toContain('ITERATION: 2');

      const iteration_2 = JSON.parse(
        readFileSync(join(workspace, '.volley', 'iterations', '002', 'summary.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(iteration_2['verdict']).toBe('approved');
    } finally {
      cleanup();
    }
  });

  it('persists --worktree and restores it on resume, defaulting off for legacy configs', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      initialize_workspace(workspace);
      write_resolved_config(test_config({ workspace, run_id: 'wt-run', worktree: true }));
      expect(load_resume_state(workspace, 'wt-run').raw_config.worktree).toBe(true);

      // A config.json written before --worktree existed (no key) restores off,
      // exactly like builder_provider's `?? claude_cli` default.
      const config_path = volley_path(workspace, 'config.json');
      const recorded = JSON.parse(readFileSync(config_path, 'utf8')) as Record<string, unknown>;
      delete recorded['worktree'];
      writeFileSync(config_path, `${JSON.stringify(recorded, null, 2)}\n`);
      expect(load_resume_state(workspace, 'wt-run').raw_config.worktree).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('rejects a run id that does not match the recorded run', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({ workspace, run_id: 'actual-run' });
      const engine = mock_engine((call) =>
        call.role === 'builder' ? { content: 'ok', cost_usd: 0.1 } : approve_reply(),
      );
      await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });
      expect(() => load_resume_state(workspace, 'wrong-run')).toThrow(/not found/);
    } finally {
      cleanup();
    }
  });
});
