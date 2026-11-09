import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aborted_error } from 'fascicle';
import { exit_code_for_status } from '../../src/exit_codes.js';
import { load_resume_state } from '../../src/iteration.js';
import { run_volley } from '../../src/orchestrator.js';
import type { ResolvedConfig } from '../../src/types.js';
import { silent_renderer, temp_git_workspace, test_config } from '../helpers/harness.js';
import { approve_reply, mock_engine, prompt_text, reject_reply } from '../helpers/mock_engine.js';
import type { MockCall, MockReply } from '../helpers/mock_engine.js';

/** The tester's calls carry no schema, as the builder's don't; its system
 * prompt tells them apart. */
function is_tester(call: MockCall): boolean {
  return typeof call.opts.system === 'string' && call.opts.system.includes('You are the tester');
}

function seat(call: MockCall): 'tester' | 'builder' | 'critic' {
  return is_tester(call) ? 'tester' : call.role;
}

/** A tester that writes `test/ledger.test.txt`, which the check requires, beside
 * `src/ledger.txt`, which only the build writes: red after the tester, green
 * after the build. */
function tester_config(workspace: string, overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return test_config({
    workspace,
    tester: true,
    check: 'test -f test/ledger.test.txt && test -f src/ledger.txt',
    check_resolved: 'command',
    ...overrides,
  });
}

function write(workspace: string, path: string, content: string): void {
  mkdirSync(join(workspace, path, '..'), { recursive: true });
  writeFileSync(join(workspace, path), content);
}

function writes_test(workspace: string, cost_usd = 0.1): MockReply {
  return {
    content: 'wrote test/ledger.test.txt',
    cost_usd,
    effect: () => write(workspace, 'test/ledger.test.txt', 'the books balance\n'),
  };
}

function writes_work(workspace: string): MockReply {
  return {
    content: 'did the work',
    cost_usd: 0.25,
    effect: () => write(workspace, 'src/ledger.txt', 'balanced\n'),
  };
}

function archived(workspace: string, iteration: number): Record<string, unknown> {
  const dir = String(iteration).padStart(3, '0');
  return JSON.parse(
    readFileSync(join(workspace, '.volley', 'iterations', dir, 'summary.json'), 'utf8'),
  ) as Record<string, unknown>;
}

function run_summary(workspace: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspace, '.volley', 'summary.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

async function run(config: ResolvedConfig, engine: ReturnType<typeof mock_engine>) {
  return run_volley(config, { renderer: silent_renderer(), engine, install_signal_handlers: false });
}

describe('the tester seat', () => {
  it('writes a red test before the first build, and the build turns it green', async () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const engine = mock_engine((call) => {
        if (is_tester(call)) return writes_test(workspace);
        if (call.role === 'builder') return writes_work(workspace);
        const reply = approve_reply();
        return { ...reply, content: { ...(reply.content as object), test_findings: ['no empty-ledger case'] } };
      });
      const result = await run(tester_config(workspace), engine);

      expect(result.status).toBe('success');
      expect(exit_code_for_status(result.status)).toBe(0);
      expect(engine.calls.map(seat)).toEqual(['tester', 'builder', 'critic']);
      // The critic reads the test as well as the work, and its findings are kept.
      expect(prompt_text(engine.calls[2])).toContain("THE TESTER'S TEST");
      expect(prompt_text(engine.calls[2])).toContain('  test/ledger.test.txt');
      expect(result.tester_cost_usd).toBeCloseTo(0.1);
      expect(result.builder_cost_usd).toBeCloseTo(0.25);
      expect(result.total_cost_usd).toBeCloseTo(0.4);

      // The builder hears of the test and the check that fails on it.
      const builder_prompt = prompt_text(engine.calls[1]);
      expect(builder_prompt).toContain("THE TESTER'S TEST");
      expect(builder_prompt).toContain('  test/ledger.test.txt');
      expect(builder_prompt).toContain('The check fails on it now, as it must (exit 1).');

      const first = archived(workspace, 1);
      expect(first['tester']).toMatchObject({ cost_usd: 0.1 });
      expect(first['tester_check']).toMatchObject({ ran: true, ok: false });
      expect(first['check']).toMatchObject({ ran: true, ok: true });
      expect(first['tester_changes']).toMatchObject({
        total: 1,
        gate_edits: ['test/ledger.test.txt'],
        files: [{ path: 'test/ledger.test.txt', status: 'added', gate: true }],
      });
      expect(Object.keys(first['tester_hashes'] as object)).toEqual(['test/ledger.test.txt']);
      // The tester's test is the tester's, not a builder gate edit.
      expect((first['changes'] as { gate_edits: string[] }).gate_edits).toEqual([]);
      expect(first['critic']).toMatchObject({ test_findings: ['no empty-ledger case'] });
      expect(run_summary(workspace)).toMatchObject({
        tester_cost_usd: 0.1,
        comparison: { tester_cost_usd: 0.1, gate_edits: [], tester_passed_early: false },
      });
    } finally {
      cleanup();
    }
  });

  it("counts a build that changes the tester's test as a gate edit", async () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const engine = mock_engine((call) => {
        if (is_tester(call)) return writes_test(workspace);
        if (call.role === 'critic') return approve_reply();
        return {
          content: 'loosened the test',
          effect: () => {
            write(workspace, 'src/ledger.txt', 'balanced\n');
            write(workspace, 'test/ledger.test.txt', 'anything goes\n');
          },
        };
      });
      const result = await run(tester_config(workspace), engine);
      expect(result.status).toBe('success');
      expect((archived(workspace, 1)['changes'] as { gate_edits: string[] }).gate_edits).toEqual([
        'test/ledger.test.txt',
      ]);
    } finally {
      cleanup();
    }
  });

  it('ends the run as tester_passed_early, exit 2, with no builder or critic call, when the check passes', async () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      write(workspace, 'src/ledger.txt', 'already balanced\n');
      const engine = mock_engine((call) => (is_tester(call) ? writes_test(workspace) : approve_reply()));
      const result = await run(tester_config(workspace), engine);

      expect(result.status).toBe('tester_passed_early');
      expect(exit_code_for_status(result.status)).toBe(2);
      expect(result.iterations_completed).toBe(1);
      expect(engine.calls.map(seat)).toEqual(['tester']);
      const first = archived(workspace, 1);
      expect(first['tester_check']).toMatchObject({ ran: true, ok: true });
      expect(first['builder']).toBeNull();
      expect(first['check']).toBeNull();
      expect(first['builds']).toBe(0);
      expect(run_summary(workspace)).toMatchObject({ comparison: { tester_passed_early: true } });
    } finally {
      cleanup();
    }
  });

  it('skips the check and the build when the tester alone crosses the cost cap', async () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const engine = mock_engine((call) => (is_tester(call) ? writes_test(workspace, 0.5) : approve_reply()));
      const result = await run(tester_config(workspace, { max_cost_usd: 0.2 }), engine);

      expect(result.status).toBe('cost_cap_reached');
      expect(exit_code_for_status(result.status)).toBe(7);
      expect(engine.calls.map(seat)).toEqual(['tester']);
      const first = archived(workspace, 1);
      expect(first['tester_check']).toMatchObject({ ran: false });
      expect(first['builder']).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('runs the tester in iteration 1 only; later iterations start at the build', async () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      let builds = 0;
      const engine = mock_engine((call) => {
        if (is_tester(call)) return writes_test(workspace);
        if (call.role === 'critic') return builds < 2 ? reject_reply('not yet') : approve_reply();
        builds += 1;
        return writes_work(workspace);
      });
      const result = await run(tester_config(workspace), engine);

      expect(result.status).toBe('success');
      expect(result.iterations_completed).toBe(2);
      expect(engine.calls.map(seat)).toEqual(['tester', 'builder', 'critic', 'builder', 'critic']);
      // Iteration 2's builder still knows the test is the tester's, with no red
      // check to report: that was iteration 1's.
      const second_build = prompt_text(engine.calls[3]);
      expect(second_build).toContain('  test/ledger.test.txt');
      expect(second_build).not.toContain('The check fails on it now');
      const second = archived(workspace, 2);
      expect(second['tester']).toBeNull();
      expect(second['tester_check']).toBeNull();
      expect(Object.keys(second['tester_hashes'] as object)).toEqual(['test/ledger.test.txt']);
    } finally {
      cleanup();
    }
  });

  it("reads the tester's hashes and spend back on resume, and doesn't run it again", async () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const config = tester_config(workspace, { run_id: 'tester-resume' });
      let builds = 0;
      const first = mock_engine((call) => {
        if (is_tester(call)) return writes_test(workspace);
        if (call.role === 'critic') return reject_reply('not yet');
        builds += 1;
        return builds === 1 ? writes_work(workspace) : { content: '', error: new aborted_error('sigint') };
      });
      await expect(run(config, first)).rejects.toThrow();

      const resume = load_resume_state(workspace, 'tester-resume');
      expect(resume.iterations_completed).toBe(1);
      expect(Object.keys(resume.state.tester_hashes)).toEqual(['test/ledger.test.txt']);
      expect(resume.state.tester_cost_usd).toBeCloseTo(0.1);

      const second = mock_engine((call) => {
        if (is_tester(call)) return writes_test(workspace);
        if (call.role === 'critic') return approve_reply();
        return { content: 'touched the test', effect: () => write(workspace, 'test/ledger.test.txt', 'loosened\n') };
      });
      const result = await run_volley(
        config,
        { renderer: silent_renderer(), engine: second, install_signal_handlers: false },
        resume.state,
      );
      expect(result.status).toBe('success');
      expect(second.calls.map(seat)).toEqual(['builder', 'critic']);
      expect(result.tester_cost_usd).toBeCloseTo(0.1);
      // The resumed build changed the tester's test, which its hash still tells.
      expect((archived(workspace, 2)['changes'] as { gate_edits: string[] }).gate_edits).toEqual([
        'test/ledger.test.txt',
      ]);
    } finally {
      cleanup();
    }
  });

  it('checkpoints after the tester under --git', async () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const engine = mock_engine((call) => {
        if (is_tester(call)) return writes_test(workspace);
        return call.role === 'builder' ? writes_work(workspace) : approve_reply();
      });
      const result = await run(tester_config(workspace, { git_checkpoints: true }), engine);
      expect(result.status).toBe('success');
      const log = spawnSync('git', ['log', '--format=%s'], { cwd: workspace, encoding: 'utf8' }).stdout;
      expect(log.split('\n')).toEqual(
        expect.arrayContaining(['volley iter 1: test', 'volley iter 1: build']),
      );
      // The tester's test landed in its own commit, before the build's work.
      const shown = spawnSync('git', ['show', '--name-only', '--format=', ':/volley iter 1: test'], {
        cwd: workspace,
        encoding: 'utf8',
      }).stdout.split('\n');
      expect(shown).toContain('test/ledger.test.txt');
      expect(shown).not.toContain('src/ledger.txt');
    } finally {
      cleanup();
    }
  });

  it('leaves a run with the tester off exactly as it was: no tester call, no tester fields set', async () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const engine = mock_engine((call) => (call.role === 'builder' ? writes_work(workspace) : approve_reply()));
      write(workspace, 'test/ledger.test.txt', 'present\n');
      const result = await run(tester_config(workspace, { tester: false }), engine);
      expect(result.status).toBe('success');
      expect(engine.calls.map(seat)).toEqual(['builder', 'critic']);
      expect(prompt_text(engine.calls[0])).not.toContain("THE TESTER'S TEST");
      expect(archived(workspace, 1)).toMatchObject({
        tester: null,
        tester_check: null,
        tester_changes: null,
        tester_hashes: {},
      });
      expect(result.tester_cost_usd).toBe(0);
    } finally {
      cleanup();
    }
  });
});
