/**
 * `run_critique` (`volley critique`): the check and the critic, once, over a
 * change already made, with no builder. A mock engine answers the critic and
 * shows that nothing else was asked of it; the check and the change detection
 * are real, against a git workspace.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolve_config } from '../../src/config.js';
import {
  EXIT_BUDGET_EXHAUSTED,
  EXIT_CONFIG_ERROR,
  EXIT_CRITIC_ERROR,
  exit_code_for_error,
  exit_code_for_status,
} from '../../src/exit_codes.js';
import { run_critique } from '../../src/orchestrator.js';
import type { RunSummary } from '../../src/summary.js';
import type { ResolvedConfig, RunResult, VolleyConfig } from '../../src/types.js';
import { silent_renderer, temp_git_workspace, temp_workspace } from '../helpers/harness.js';
import { approve_reply, mock_engine, prompt_text, reject_reply } from '../helpers/mock_engine.js';
import type { MockReply } from '../helpers/mock_engine.js';

/** The test file's own state root (`test/setup.ts`). */
const STATE_HOME = process.env['XDG_STATE_HOME'] ?? '';

function git(repo: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function write(repo: string, path: string, content: string): void {
  mkdirSync(join(repo, path, '..'), { recursive: true });
  writeFileSync(join(repo, path), content);
}

/** A repo whose HEAD is the base commit: a parser and its test. */
function base_repo(): { workspace: string; base: string; cleanup: () => void } {
  const { workspace, cleanup } = temp_git_workspace();
  write(workspace, 'src/parse.mjs', 'export const parse = (s) => s.split(",");\n');
  write(workspace, 'test/parse.test.mjs', 'import "node:test";\n');
  git(workspace, ['add', '-A']);
  git(workspace, ['commit', '-q', '-m', 'base']);
  return { workspace, base: git(workspace, ['rev-parse', 'HEAD']), cleanup };
}

function critique_config(
  workspace: string,
  raw: Partial<VolleyConfig> = {},
  run_id?: string,
): ResolvedConfig {
  return resolve_config(
    {
      workspace,
      criteria: 'parse handles empty input',
      check: 'test -f src/parse.mjs',
      ...raw,
    } as VolleyConfig,
    {
      mode: 'critique',
      env: { XDG_STATE_HOME: STATE_HOME },
      ...(run_id !== undefined ? { run_id } : {}),
    },
  );
}

/** One critique with a critic that answers `reply`, and the engine, whose
 * calls say which seats were asked for. */
async function critique(
  config: ResolvedConfig,
  reply: MockReply,
  baseline?: string,
): Promise<{ result: RunResult; engine: ReturnType<typeof mock_engine> }> {
  const engine = mock_engine(() => reply);
  const result = await run_critique(config, {
    renderer: silent_renderer(),
    engine,
    install_signal_handlers: false,
    ...(baseline !== undefined ? { baseline } : {}),
  });
  return { result, engine };
}

function read_json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function archived(result: RunResult): Record<string, unknown> {
  return read_json(join(result.run_state_dir, 'iterations', '001', 'summary.json'));
}

function changed_paths(result: RunResult): string[] {
  const changes = archived(result)['changes'] as { files: { path: string }[] };
  return changes.files.map((file) => file.path);
}

describe('a critique of the change since --baseline', () => {
  it('runs the check once and the critic once, never a builder, over exactly what differs', async () => {
    const { workspace, base, cleanup } = base_repo();
    try {
      // The change: one commit over the base, and an untracked file on top.
      write(workspace, 'src/parse.mjs', 'export const parse = (s) => (s === "" ? [] : s.split(","));\n');
      write(workspace, 'test/parse.test.mjs', 'import "node:test"; // empty input\n');
      git(workspace, ['commit', '-q', '-am', 'handle empty input']);
      write(workspace, 'notes.md', 'why\n');

      const { result, engine } = await critique(critique_config(workspace), approve_reply(), base);

      expect(engine.calls.map((call) => call.role)).toEqual(['critic']);
      expect(result).toMatchObject({ status: 'success', mode: 'critique', iterations_completed: 1 });
      expect(changed_paths(result)).toEqual(['notes.md', 'src/parse.mjs', 'test/parse.test.mjs']);
      const iteration = archived(result);
      expect(iteration['builder']).toBeNull();
      expect(iteration['check']).toMatchObject({ ran: true, ok: true });
      expect(iteration['changes']).toMatchObject({
        baseline: base,
        gate_edits: ['test/parse.test.mjs'],
      });
      // The critic sees the change and the gate edit as a run's critic would.
      const prompt = prompt_text(engine.calls[0]);
      expect(prompt).toContain('src/parse.mjs');
      expect(prompt).toContain('test/parse.test.mjs');
    } finally {
      cleanup();
    }
  });

  it('takes the uncommitted and untracked edits as the change when no baseline is named', async () => {
    const { workspace, base, cleanup } = base_repo();
    try {
      write(workspace, 'src/parse.mjs', 'export const parse = (s) => [];\n');
      write(workspace, 'src/empty.mjs', 'export const empty = [];\n');

      const { result } = await critique(critique_config(workspace), approve_reply());
      expect(changed_paths(result)).toEqual(['src/empty.mjs', 'src/parse.mjs']);
      expect(archived(result)['changes']).toMatchObject({ baseline: base });
    } finally {
      cleanup();
    }
  });
});

describe("a critique's state", () => {
  it('holds the files a one-round run writes, with the mode recorded, and none in the workspace', async () => {
    const { workspace, cleanup } = base_repo();
    try {
      write(workspace, 'src/parse.mjs', 'export const parse = (s) => [];\n');
      const config = critique_config(workspace, {}, 'critique-state');
      const { result } = await critique(config, approve_reply('All met.'));

      const dir = join(STATE_HOME, 'volley', 'critique-state');
      expect(result.run_state_dir).toBe(dir);
      for (const file of [
        'config.json',
        'summary.json',
        'trajectory.jsonl',
        'feedback.md',
        'verdict',
        join('iterations', '001', 'summary.json'),
        join('iterations', '001', 'check', 'check.log'),
      ]) {
        expect(existsSync(join(dir, file)), file).toBe(true);
      }
      expect(read_json(join(dir, 'config.json'))['mode']).toBe('critique');
      const summary = read_json(join(dir, 'summary.json')) as unknown as RunSummary;
      expect(summary).toMatchObject({ mode: 'critique', status: 'success' });
      expect(summary.comparison).toMatchObject({
        builder_transport: null,
        iterations_to_converge: 1,
        final_verdict: 'approved',
      });
      expect(readdirSync(workspace).toSorted()).toEqual(['.git', 'src', 'test']);
    } finally {
      cleanup();
    }
  });
});

describe("a critique's outcome", () => {
  it('ends rejected, exit 2, when the critic asks for changes or the check is red', async () => {
    const { workspace, cleanup } = base_repo();
    try {
      write(workspace, 'src/parse.mjs', 'export const parse = (s) => [];\n');
      const asked = await critique(critique_config(workspace), reject_reply('- test it'));
      expect(asked.result).toMatchObject({ status: 'rejected', final_verdict: 'changes_requested' });

      const red = await critique(
        critique_config(workspace, { check: 'test -f src/missing.mjs' }),
        approve_reply(),
      );
      expect(red.result).toMatchObject({ status: 'rejected', final_verdict: 'approved' });
      expect(exit_code_for_status('rejected')).toBe(EXIT_BUDGET_EXHAUSTED);
    } finally {
      cleanup();
    }
  });

  it('exits as a run does when the critic fails', async () => {
    const { workspace, cleanup } = base_repo();
    try {
      const config = critique_config(workspace, {}, 'critic-dies');
      const caught = await critique(config, { content: '', error: new Error('critic down') }).then(
        () => null,
        (err: unknown) => err,
      );
      expect(exit_code_for_error(caught)).toBe(EXIT_CRITIC_ERROR);
      expect(read_json(join(STATE_HOME, 'volley', 'critic-dies', 'summary.json'))['status']).toBe(
        'error',
      );
    } finally {
      cleanup();
    }
  });
});

describe('a critique that cannot start', () => {
  it('refuses a --baseline that names no commit, before any state is written', async () => {
    const { workspace, cleanup } = base_repo();
    try {
      const config = critique_config(workspace, {}, 'bad-baseline');
      const caught = await critique(config, approve_reply(), 'no-such-rev').then(
        () => null,
        (err: unknown) => err,
      );
      expect(exit_code_for_error(caught)).toBe(EXIT_CONFIG_ERROR);
      expect((caught as Error).message).toBe(`--baseline names no commit in ${workspace}: no-such-rev`);
      expect(existsSync(join(STATE_HOME, 'volley', 'bad-baseline'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('refuses a --baseline where there is no repository, and a config resolved as a run', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      await expect(critique(critique_config(workspace), approve_reply(), 'HEAD')).rejects.toThrow(
        `--baseline needs the workspace to be a git repository: ${workspace}`,
      );
      const run = resolve_config(
        { prompt: 'p', workspace, criteria: 'c', check: 'none' },
        { env: { XDG_STATE_HOME: STATE_HOME } },
      );
      await expect(critique(run, approve_reply())).rejects.toThrow(
        "run_critique needs a config resolved with mode 'critique'",
      );
    } finally {
      cleanup();
    }
  });
});
