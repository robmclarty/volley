/**
 * `volley critique` from the command line: the flags it refuses, its dry run,
 * and its exit codes, with the critic on a stand-in OpenRouter server.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_BUDGET_EXHAUSTED, EXIT_CONFIG_ERROR, EXIT_SUCCESS } from '../../src/exit_codes.js';
import { cli_env, spawn_cli } from '../helpers/cli.js';
import type { CliResult } from '../helpers/cli.js';
import { temp_git_workspace } from '../helpers/harness.js';
import { close_servers } from '../helpers/http_server.js';
import { stub_openai } from '../helpers/openai_stub.js';

const KEY = 'sk-or-test';

afterEach(async () => {
  await close_servers();
});

/** A repo with one committed file, and an uncommitted edit to it: the change. */
function changed_repo(): { workspace: string; cleanup: () => void } {
  const { workspace, cleanup } = temp_git_workspace();
  const git = (args: string[]) => spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
  writeFileSync(join(workspace, 'parse.mjs'), 'export const parse = () => [];\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  writeFileSync(join(workspace, 'parse.mjs'), 'export const parse = (s) => (s ? [s] : []);\n');
  return { workspace, cleanup };
}

function critique(workspace: string, args: string[]): Promise<CliResult> {
  return spawn_cli(
    ['critique', '--workspace', workspace, '--criteria', 'parse handles empty input', ...args],
    cli_env({ OPENROUTER_API_KEY: KEY }),
  );
}

describe('volley critique refuses', () => {
  it('every flag only a builder or its loop uses, naming it, with exit 5', async () => {
    const { workspace, cleanup } = changed_repo();
    try {
      const refused: ReadonlyArray<readonly [string[], string]> = [
        [['--builder-provider', 'ollama'], '--builder-provider (builder_provider)'],
        [['--builder-model', 'opus'], '--builder-model (builder_model)'],
        [['--max-iterations', '3'], '--max-iterations (max_iterations)'],
        [['--max-cost-usd', '1'], '--max-cost-usd (max_cost_usd)'],
        [['--worktree'], '--worktree (worktree)'],
        [['--git'], '--git (git_checkpoints)'],
        [['--fail-on-gate-edit'], '--fail-on-gate-edit (fail_on_gate_edit)'],
      ];
      const results = await Promise.all(
        refused.map(([flag]) => critique(workspace, [...flag, '--dry-run'])),
      );
      results.forEach(({ status, stderr }, index) => {
        const named = refused[index]?.[1] ?? '';
        expect(status, named).toBe(EXIT_CONFIG_ERROR);
        expect(stderr).toContain(`volley critique refuses ${named}: a critique runs no builder and no loop`);
      });
    } finally {
      cleanup();
    }
  });

  it("--config, a bare-number --baseline, and a --baseline that names no commit", async () => {
    const { workspace, cleanup } = changed_repo();
    try {
      const [config, bare, missing] = await Promise.all([
        critique(workspace, ['--config', 'volley.config.ts', '--dry-run']),
        critique(workspace, ['--baseline', '0042', '--dry-run']),
        critique(workspace, ['--baseline', 'no-such-rev', '--dry-run']),
      ]);
      expect(config.status).toBe(EXIT_CONFIG_ERROR);
      expect(config.stderr).toContain("volley critique refuses --config: a run's config file sets a builder");
      expect(bare.status).toBe(EXIT_CONFIG_ERROR);
      expect(bare.stderr).toContain('--baseline must not be a bare number (read as 42)');
      expect(missing.status).toBe(EXIT_CONFIG_ERROR);
      expect(missing.stderr).toContain(`--baseline names no commit in ${workspace}: no-such-rev`);
    } finally {
      cleanup();
    }
  });
});

describe('volley critique --dry-run', () => {
  it('names the baseline and the state root, and no builder', async () => {
    const { workspace, cleanup } = changed_repo();
    try {
      const { status, stderr } = await critique(workspace, ['--check', 'none', '--dry-run']);
      expect(status).toBe(EXIT_SUCCESS);
      expect(stderr).toMatch(/baseline: [0-9a-f]{40}/);
      expect(stderr).toContain('builder: none (a critique checks and critiques the change once)');
      expect(stderr).toContain(`state root: ${join(process.env['XDG_STATE_HOME'] ?? '', 'volley')}`);
      expect(stderr).not.toContain('builder model');
    } finally {
      cleanup();
    }
  });
});

describe('volley critique on a stand-in critic', () => {
  /** A critique of the repo's change with the critic answering `verdict`. */
  async function verdict_run(verdict: 'approved' | 'changes_requested') {
    const critic = await stub_openai(
      JSON.stringify({ verdict, feedback: verdict === 'approved' ? 'Fine.' : '- test it', unmet_criteria: [] }),
    );
    const { workspace, cleanup } = changed_repo();
    try {
      const result = await critique(workspace, [
        '--check',
        'test -f parse.mjs',
        '--critic-provider',
        'openrouter',
        '--critic-model',
        'vendor/critic',
        '--critic-url',
        critic.url,
        '--json',
      ]);
      return { ...result, critic };
    } finally {
      cleanup();
    }
  }

  it('exits 0 on approval over a green check, with only the critic asked, and the mode recorded', async () => {
    const { status, stdout, critic } = await verdict_run('approved');
    expect(status).toBe(EXIT_SUCCESS);
    expect(JSON.parse(stdout)).toMatchObject({
      mode: 'critique',
      status: 'success',
      iterations_completed: 1,
      final_verdict: 'approved',
    });
    expect(critic.seen.filter((r) => r.path.endsWith('/chat/completions')).map((r) => r.model)).toEqual([
      'vendor/critic',
    ]);
  });

  it('exits 2 when the critic asks for changes', async () => {
    const { status, stdout } = await verdict_run('changes_requested');
    expect(status).toBe(EXIT_BUDGET_EXHAUSTED);
    expect(JSON.parse(stdout)).toMatchObject({ mode: 'critique', status: 'rejected' });
  });
});
