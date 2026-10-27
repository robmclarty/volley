import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aborted_error } from 'fascicle';
import { find_run_state, load_resume_state } from '../../src/iteration.js';
import { run_volley } from '../../src/orchestrator.js';
import { exit_code_for_error } from '../../src/exit_codes.js';
import { error_kind } from '../../src/types.js';
import { initialize_run_state, state_path, write_resolved_config } from '../../src/workspace.js';
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

  it("carries a failed command check's output into the resumed run's first builder", async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({
        workspace,
        run_id: 'red-command-run',
        max_iterations: 3,
        check: 'echo "FAIL widget spins"; exit 1',
        check_resolved: 'command',
      });
      const engine_1 = mock_engine((call, index) => {
        if (call.role === 'critic') return reject_reply('the widget still spins');
        return index === 0
          ? { content: 'first pass', cost_usd: 0.1 }
          : { content: '', error: new aborted_error('sigint') };
      });
      await expect(
        run_volley(config, { renderer: silent_renderer(), engine: engine_1, install_signal_handlers: false }),
      ).rejects.toThrow();

      const resume = load_resume_state(workspace, 'red-command-run');
      expect(resume.state.check).toMatchObject({ ran: true, runner: 'command', ok: false, exit_code: 1 });
      expect(resume.state.check?.log).toContain('FAIL widget spins');
      // It stopped on its own, so there's no step limit to mention.
      expect(resume.state.builder?.finish_reason).toBe('stop');

      const engine_2 = mock_engine((call) =>
        call.role === 'builder' ? { content: 'fixed', cost_usd: 0.1 } : approve_reply(),
      );
      await run_volley(
        config,
        { renderer: silent_renderer(), engine: engine_2, install_signal_handlers: false },
        resume.state,
      );
      const resumed = prompt_text(engine_2.calls.find((c) => c.role === 'builder'));
      expect(resumed).toContain('The check failed on the work your last session left (exit 1).');
      expect(resumed).toContain('FAIL widget spins');
      expect(resumed).not.toContain('step limit');
    } finally {
      cleanup();
    }
  });

  it('persists the worktree flags and restores them on resume, defaulting off for legacy configs', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({
        workspace,
        run_id: 'wt-run',
        worktree: true,
        discard_worktree: true,
      });
      initialize_run_state(config);
      write_resolved_config(config);
      const restored = load_resume_state(workspace, 'wt-run').raw_config;
      expect(restored.worktree).toBe(true);
      // The throw-away mode rides along: a resumed matrix seat must not start
      // keeping a branch the sweep never asked for.
      expect(restored.discard_worktree).toBe(true);

      // A config.json written before these keys existed restores both off,
      // exactly like builder_provider's `?? claude_cli` default.
      const config_path = state_path(config, 'config.json');
      const recorded = JSON.parse(readFileSync(config_path, 'utf8')) as Record<string, unknown>;
      delete recorded['worktree'];
      delete recorded['discard_worktree'];
      writeFileSync(config_path, `${JSON.stringify(recorded, null, 2)}\n`);
      // An older volley's config carries no signature, so it resumes only trusted.
      const legacy = load_resume_state(workspace, 'wt-run', null, { trust_config: true }).raw_config;
      expect(legacy.worktree).toBe(false);
      expect(legacy.discard_worktree).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('finds a run kept under a state root by its id, and restores the root', () => {
    const { workspace, cleanup } = temp_workspace();
    const root = mkdtempSync(join(tmpdir(), 'volley-state-'));
    try {
      const config = test_config({ workspace, run_id: 'rooted-run', state_dir: root });
      initialize_run_state(config);
      write_resolved_config(config);

      const resume = load_resume_state(workspace, 'rooted-run', root);
      expect(resume.raw_config.state_dir).toBe(root);
      // Without the root, the run is looked for in the workspace, where it never was.
      expect(() => load_resume_state(workspace, 'rooted-run')).toThrow(
        `no resumable run found: ${join(workspace, '.volley', 'config.json')} missing`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      cleanup();
    }
  });

  it('looks under the root, then in a .volley/ that names the run, and says where it looked', () => {
    const { workspace, cleanup } = temp_workspace();
    const root = mkdtempSync(join(tmpdir(), 'volley-state-'));
    try {
      const rooted = test_config({ workspace, run_id: 'rooted-run', state_dir: root });
      initialize_run_state(rooted);
      write_resolved_config(rooted);
      // A run an older volley kept in the workspace.
      const legacy = test_config({ workspace, run_id: 'legacy-run' });
      initialize_run_state(legacy);
      write_resolved_config(legacy);

      expect(find_run_state(workspace, 'rooted-run', root)).toBe(root);
      expect(find_run_state(workspace, 'legacy-run', root)).toBeNull();
      expect(() => find_run_state(workspace, 'missing-run', root)).toThrow(
        `run missing-run not found in ${join(root, 'missing-run')} or in ` +
          `${join(workspace, '.volley')} (it holds run "legacy-run")`,
      );
      expect(() => find_run_state(workspace, '../rooted-run', root)).toThrow('not a run id: ../rooted-run');
    } finally {
      rmSync(root, { recursive: true, force: true });
      cleanup();
    }
  });

  it('refuses a run directory with a symlink in it, before reading or pruning anything', () => {
    const { workspace, cleanup } = temp_workspace();
    const root = mkdtempSync(join(tmpdir(), 'volley-state-'));
    const host_dir = mkdtempSync(join(tmpdir(), 'volley-host-'));
    try {
      const config = test_config({ workspace, run_id: 'planted', state_dir: root });
      initialize_run_state(config);
      write_resolved_config(config);
      // What a contained builder could leave in its own run's state: a
      // half-finished iteration that is really a directory of the host's.
      const planted = join(root, 'planted', 'iterations', '002');
      symlinkSync(host_dir, planted);

      expect(() => load_resume_state(workspace, 'planted', root)).toThrow(
        `refusing to resume: ${planted} is a symbolic link, which volley never writes`,
      );
      // The prune of half-finished iterations never reached the host's directory.
      expect(existsSync(host_dir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(host_dir, { recursive: true, force: true });
      cleanup();
    }
  });

  it('refuses to resume a critique, which has one round and nothing to resume', () => {
    const { workspace, cleanup } = temp_workspace();
    const root = mkdtempSync(join(tmpdir(), 'volley-state-'));
    try {
      const config = test_config({ workspace, run_id: 'a-critique', state_dir: root, mode: 'critique' });
      initialize_run_state(config);
      write_resolved_config(config);
      expect(() => load_resume_state(workspace, 'a-critique', root)).toThrow(
        'run a-critique is a critique, which has one round and nothing to resume; run volley critique again',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
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
