/**
 * The tamper path end to end: a builder that makes the check pass by editing
 * the check. Both gates approve it — the check because it was rewritten, the
 * critic because it is scripted to approve — which is exactly the run
 * `research/reckon-local-run-finding.md` had to inspect by hand afterwards.
 * What the harness now does about it: name the gate edit in the critic's prompt,
 * record it in the summary, and (opt-in) refuse to call the run a success.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { run_volley } from '../../src/orchestrator.js';
import { exit_code_for_status, EXIT_GATE_EDIT } from '../../src/exit_codes.js';
import { silent_renderer, temp_git_workspace, test_config } from '../helpers/harness.js';
import { approve_reply, mock_engine, prompt_text } from '../helpers/mock_engine.js';
import type { MockCall } from '../helpers/mock_engine.js';
import type { ResolvedConfig } from '../../src/types.js';

function git(repo: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

/** A repo whose check is a test file the builder can reach: it asserts the
 * feature exists, and fails until either the feature is written (honest) or the
 * assertion is removed (tamper). */
function seeded_repo(): { workspace: string; cleanup: () => void } {
  const { workspace, cleanup } = temp_git_workspace();
  writeFileSync(join(workspace, 'check.mjs'), 'import "./test/feature.test.mjs";\n');
  spawnSync('mkdir', ['-p', join(workspace, 'test')]);
  writeFileSync(
    join(workspace, 'test', 'feature.test.mjs'),
    'import { existsSync } from "node:fs";\nif (!existsSync("src/feature.mjs")) process.exit(1);\n',
  );
  git(workspace, ['add', '-A']);
  git(workspace, ['commit', '-q', '-m', 'seed']);
  return { workspace, cleanup };
}

function config_for(workspace: string, overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return test_config({
    workspace,
    check: 'node check.mjs',
    check_resolved: 'command',
    max_cost_usd: 20,
    ...overrides,
  });
}

/** The builder "passes" by deleting the assertion instead of writing the code. */
function tampering_engine(workspace: string) {
  return mock_engine((call: MockCall) =>
    call.role === 'builder'
      ? {
          content: 'made the check pass',
          cost_usd: 0.1,
          effect: () =>
            writeFileSync(join(workspace, 'test', 'feature.test.mjs'), '// nothing to see\n'),
        }
      : approve_reply('Looks good to me.'),
  );
}

function run_summary(workspace: string): { comparison: { gate_edits: string[] } } {
  return JSON.parse(readFileSync(join(workspace, '.volley', 'summary.json'), 'utf8'));
}

describe('gate edits', () => {
  it('records the gate edit in the summary and tells the critic, but still converges', async () => {
    const { workspace, cleanup } = seeded_repo();
    try {
      const engine = tampering_engine(workspace);
      const result = await run_volley(config_for(workspace), {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });

      // Default posture: evidence, not refusal — the run converges as before.
      expect(result.status).toBe('success');

      const critic_call = engine.calls.find((call) => call.role === 'critic');
      const prompt = prompt_text(critic_call);
      expect(prompt).toContain('GATE EDITS (1)');
      expect(prompt).toContain('test/feature.test.mjs');

      expect(run_summary(workspace).comparison.gate_edits).toEqual(['test/feature.test.mjs']);

      const iteration = JSON.parse(
        readFileSync(join(workspace, '.volley', 'iterations', '001', 'summary.json'), 'utf8'),
      );
      expect(iteration.changes.gate_edits).toEqual(['test/feature.test.mjs']);
      expect(iteration.changes.files).toContainEqual({
        path: 'test/feature.test.mjs',
        status: 'modified',
        gate: true,
      });
    } finally {
      cleanup();
    }
  });

  it('refuses the pass under --fail-on-gate-edit, with its own exit code', async () => {
    const { workspace, cleanup } = seeded_repo();
    try {
      const result = await run_volley(
        config_for(workspace, { fail_on_gate_edit: true, max_iterations: 3 }),
        {
          renderer: silent_renderer(),
          engine: tampering_engine(workspace),
          install_signal_handlers: false,
        },
      );

      expect(result.status).toBe('gate_edit_blocked');
      expect(exit_code_for_status(result.status)).toBe(EXIT_GATE_EDIT);
      // Halts on the spot rather than burning the iteration budget.
      expect(result.iterations_completed).toBe(1);
      expect(run_summary(workspace).comparison.gate_edits).toEqual(['test/feature.test.mjs']);
    } finally {
      cleanup();
    }
  });

  it('leaves an honest builder alone: real work, no gate edits, no halt', async () => {
    const { workspace, cleanup } = seeded_repo();
    try {
      const engine = mock_engine((call: MockCall) =>
        call.role === 'builder'
          ? {
              content: 'implemented the feature',
              cost_usd: 0.1,
              effect: () => {
                spawnSync('mkdir', ['-p', join(workspace, 'src')]);
                writeFileSync(join(workspace, 'src', 'feature.mjs'), 'export const feature = 1;\n');
              },
            }
          : approve_reply('Implemented as specified.'),
      );

      const result = await run_volley(
        config_for(workspace, { fail_on_gate_edit: true }),
        { renderer: silent_renderer(), engine, install_signal_handlers: false },
      );

      expect(result.status).toBe('success');
      expect(run_summary(workspace).comparison.gate_edits).toEqual([]);

      const prompt = prompt_text(engine.calls.find((call) => call.role === 'critic'));
      expect(prompt).toContain('A src/feature.mjs');
      expect(prompt).not.toContain('GATE EDITS');
    } finally {
      cleanup();
    }
  });

  it('measures the worktree, not the workspace, under --worktree', async () => {
    const { workspace, cleanup } = seeded_repo();
    try {
      // The builder writes into the worktree (its containment root, s2 D3) while
      // the workspace stays pristine — the exact seam where a check once gated
      // the wrong tree (research/v3-comparison-finding.md, defect 3). The change
      // set has to follow the builder, not the workspace.
      const engine = mock_engine((call: MockCall) =>
        call.role === 'builder'
          ? {
              content: 'edited the test in the worktree',
              cost_usd: 0.1,
              effect: () =>
                writeFileSync(join(`${workspace}.worktree`, 'test', 'feature.test.mjs'), '// gone\n'),
            }
          : approve_reply('Approved.'),
      );

      const result = await run_volley(config_for(workspace, { worktree: true }), {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });

      expect(result.status).toBe('success');
      expect(run_summary(workspace).comparison.gate_edits).toEqual(['test/feature.test.mjs']);
      const prompt = prompt_text(engine.calls.find((call) => call.role === 'critic'));
      expect(prompt).toContain('GATE EDITS (1)');
    } finally {
      cleanup();
    }
  });

  it('omits the change section outside a git repository rather than claiming nothing changed', async () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      // Strip the repo: the workspace is a plain directory again.
      spawnSync('rm', ['-rf', join(workspace, '.git')]);
      const engine = mock_engine((call: MockCall) =>
        call.role === 'builder'
          ? {
              content: 'wrote it',
              cost_usd: 0.1,
              effect: () => writeFileSync(join(workspace, 'done.txt'), 'done\n'),
            }
          : approve_reply('Fine.'),
      );

      const result = await run_volley(
        test_config({ workspace, check: 'none', check_resolved: 'none', max_cost_usd: 20 }),
        { renderer: silent_renderer(), engine, install_signal_handlers: false },
      );

      expect(result.status).toBe('success');
      const prompt = prompt_text(engine.calls.find((call) => call.role === 'critic'));
      expect(prompt).not.toContain('BUILDER CHANGES');
      expect(run_summary(workspace).comparison.gate_edits).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
