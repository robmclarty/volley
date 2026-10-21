/**
 * `--state-dir`: a run's state kept under `<root>/<run_id>/` instead of the
 * workspace's `.volley/`. In-process runs show where each file lands; spawned
 * CLI runs against stand-in OpenRouter servers show `volley resume` finding a
 * run under a root, and `volley matrix` reading a seat back from one.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aborted_error } from 'fascicle';
import { afterEach, describe, expect, it } from 'vitest';
import { resolve_config } from '../../src/config.js';
import { EXIT_SUCCESS } from '../../src/exit_codes.js';
import { run_volley } from '../../src/orchestrator.js';
import type { ResolvedConfig, RunResult } from '../../src/types.js';
import {
  silent_renderer,
  temp_git_workspace,
  temp_workspace,
  test_config,
} from '../helpers/harness.js';
import { close_servers, start_server } from '../helpers/http_server.js';
import { approve_reply, mock_engine, reject_reply } from '../helpers/mock_engine.js';
import { stub_openai } from '../helpers/openai_stub.js';
import type { StubOpenAi } from '../helpers/openai_stub.js';

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));

const KEY = 'sk-or-test';

const APPROVED = JSON.stringify({
  verdict: 'approved',
  feedback: 'Looks good.',
  unmet_criteria: [],
});

/** Every file a run keeps in its state directory, iterations included. */
const STATE_FILES = [
  'config.json',
  'summary.json',
  'trajectory.jsonl',
  'feedback.md',
  'verdict',
  join('iterations', '001', 'summary.json'),
  join('iterations', '001', 'check', 'check.log'),
];

/** The test file's own `XDG_STATE_HOME` (`test/setup.ts`), and the default
 * root a run resolves under it. */
const STATE_HOME = process.env['XDG_STATE_HOME'] ?? '';
const DEFAULT_ROOT = join(STATE_HOME, 'volley');

const roots: string[] = [];

/** A fresh state root, swept after the test. */
function temp_root(): string {
  const root = mkdtempSync(join(tmpdir(), 'volley-state-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await close_servers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** One round: the builder writes `done.txt`, the check finds it, the critic
 * approves. */
async function run_once(config: ResolvedConfig): Promise<RunResult> {
  const engine = mock_engine((call) =>
    call.role === 'builder'
      ? {
          content: 'wrote the file',
          effect: () => writeFileSync(join(config.workspace, 'done.txt'), 'done\n'),
        }
      : approve_reply('All criteria met.'),
  );
  return run_volley(config, { renderer: silent_renderer(), engine, install_signal_handlers: false });
}

function checked_config(workspace: string, overrides: Partial<ResolvedConfig>): ResolvedConfig {
  return test_config({
    workspace,
    check: 'test -f done.txt',
    check_resolved: 'command',
    ...overrides,
  });
}

function read_json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/** The developer's shell, minus anything that would re-point, reprice,
 * re-key, or contain an openrouter seat, plus the test's key and the
 * uncontained opt-out a resumed tool-loop builder needs. */
function child_env(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    'VOLLEY_OPENROUTER_URL',
    'VOLLEY_CONTAINED',
    'VOLLEY_MODEL_HOST',
    'VOLLEY_PRICING_PATH',
  ]) {
    delete env[name];
  }
  return {
    ...env,
    OPENROUTER_API_KEY: KEY,
    VOLLEY_ALLOW_UNSANDBOXED_BUILDER: '1',
    VOLLEY_AUTH_MODE: 'auto',
  };
}

/** Spawn the CLI from the repo, where `tsx` resolves, without blocking this
 * process, whose stand-in servers have to answer the child's requests. */
function run_cli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
      env: child_env(),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

describe('a run under --state-dir', () => {
  it("keeps its config, summary, trajectory, feedback, verdict, and iterations under <root>/<run_id>/, and nothing in the workspace", async () => {
    const { workspace, cleanup } = temp_workspace();
    const root = temp_root();
    try {
      const config = checked_config(workspace, { run_id: 'rooted-run', state_dir: root });
      const result = await run_once(config);
      expect(result.status).toBe('success');

      const dir = join(root, 'rooted-run');
      for (const file of STATE_FILES) expect(existsSync(join(dir, file)), file).toBe(true);
      expect(readFileSync(join(dir, 'verdict'), 'utf8')).toBe('approved\n');
      expect(read_json(join(dir, 'config.json'))['state_dir']).toBe(root);
      expect(read_json(join(dir, 'summary.json'))).toMatchObject({
        status: 'success',
        run_state_dir: dir,
      });
      expect(result.run_state_dir).toBe(dir);
      expect(readdirSync(root)).toEqual(['rooted-run']);

      // Only the builder's own work is left in the workspace.
      expect(readdirSync(workspace)).toEqual(['done.txt']);
    } finally {
      cleanup();
    }
  });

  it("rotates a reused run id's directory aside rather than mixing two runs in it", async () => {
    const { workspace, cleanup } = temp_workspace();
    const root = temp_root();
    try {
      const config = checked_config(workspace, { run_id: 'reused', state_dir: root });
      await run_once(config);
      await run_once(config);

      const entries = readdirSync(root).toSorted();
      expect(entries).toHaveLength(2);
      expect(entries[0]).toBe('reused');
      expect(entries[1]).toMatch(/^reused\.bak\./);
      expect(existsSync(join(workspace, '.volley'))).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe('a run with no --state-dir', () => {
  it('keeps its state under the default root, and leaves only the builder\'s work in the workspace', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config(
        { prompt: 'p', workspace, criteria: 'c', check: 'test -f done.txt' },
        { cwd: workspace, run_id: 'default-run', env: { XDG_STATE_HOME: STATE_HOME } },
      );
      expect(config.state_dir).toBe(DEFAULT_ROOT);
      const result = await run_once(config);
      expect(result.status).toBe('success');

      const dir = join(DEFAULT_ROOT, 'default-run');
      expect(result.run_state_dir).toBe(dir);
      for (const file of STATE_FILES) expect(existsSync(join(dir, file)), file).toBe(true);
      expect(readdirSync(workspace)).toEqual(['done.txt']);
    } finally {
      cleanup();
    }
  });
});

describe('a check that reads every file in the tree', () => {
  // markdownlint-cli2, cspell, and checkride's links walk all read dot-dirs,
  // so a check like theirs failed from round 2 on over the run's own
  // feedback.md, which the builder can't fix, and the run never converged.
  const EVERY_MD = `test -z "$(find . -name '*.md' -not -path './.git/*')"`;

  /** Round 1 writes the file and is sent back; round 2 is approved. */
  function two_rounds(config: ResolvedConfig): Promise<RunResult> {
    let critiques = 0;
    const engine = mock_engine((call) => {
      if (call.role === 'builder') {
        return {
          content: 'wrote the file',
          effect: () => writeFileSync(join(config.workspace, 'done.txt'), 'done\n'),
        };
      }
      critiques += 1;
      return critiques === 1 ? reject_reply('- say why in the commit') : approve_reply('All met.');
    });
    return run_volley(config, { renderer: silent_renderer(), engine, install_signal_handlers: false });
  }

  it('converges with the run state under the default root', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = checked_config(workspace, {
        check: EVERY_MD,
        max_iterations: 2,
        state_dir: DEFAULT_ROOT,
      });
      const result = await two_rounds(config);
      expect(result).toMatchObject({ status: 'success', iterations_completed: 2 });
    } finally {
      cleanup();
    }
  });

  it("never converges with it in the workspace's .volley/, the old default", async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = checked_config(workspace, { check: EVERY_MD, max_iterations: 2 });
      const result = await two_rounds(config);
      expect(result).toMatchObject({ status: 'budget_exhausted', iterations_completed: 2 });
      const archived = read_json(join(workspace, '.volley', 'iterations', '002', 'summary.json'));
      expect(archived['check']).toMatchObject({ ok: false });
    } finally {
      cleanup();
    }
  });
});

describe('a run handed an empty run directory', () => {
  it('uses it as it is, as a contained run uses the directory mounted for it', async () => {
    const { workspace, cleanup } = temp_workspace();
    const root = temp_root();
    try {
      // A mount point can't be renamed aside, and an empty one holds no run.
      mkdirSync(join(root, 'mounted'));
      const result = await run_once(checked_config(workspace, { run_id: 'mounted', state_dir: root }));
      expect(result.status).toBe('success');
      expect(readdirSync(root)).toEqual(['mounted']);
      expect(existsSync(join(root, 'mounted', 'summary.json'))).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe('a --state-dir inside the workspace', () => {
  it('stays out of the change list the critic reads and out of every --git checkpoint', async () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const root = join(workspace, 'runs');
      const result = await run_once(
        checked_config(workspace, { run_id: 'in-tree', state_dir: root, git_checkpoints: true }),
      );
      expect(result.status).toBe('success');

      const archived = read_json(join(root, 'in-tree', 'iterations', '001', 'summary.json'));
      const changes = archived['changes'] as { files: { path: string }[] };
      expect(changes.files.map((file) => file.path)).toEqual(['done.txt']);

      const head = spawnSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
        cwd: workspace,
        encoding: 'utf8',
      });
      expect(head.stdout.split('\n').filter(Boolean)).toEqual(['done.txt']);
    } finally {
      cleanup();
    }
  });

  it('is refused when it is the workspace itself', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      expect(() =>
        resolve_config(
          { prompt: 'p', workspace, criteria: 'c', check: 'none', state_dir: '.' },
          { cwd: workspace, env: {} },
        ),
      ).toThrow(`--state-dir (state_dir) can't be the workspace itself: ${workspace}`);
    } finally {
      cleanup();
    }
  });
});

describe('a run in the layout older runs used (state_dir null)', () => {
  it("keeps every file in the workspace's .volley/, and rotates a prior run aside", async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      await run_once(checked_config(workspace, { run_id: 'first-run' }));
      const second = await run_once(checked_config(workspace, { run_id: 'second-run' }));

      const dir = join(workspace, '.volley');
      expect(second.run_state_dir).toBe(dir);
      for (const file of STATE_FILES) expect(existsSync(join(dir, file)), file).toBe(true);
      expect(read_json(join(dir, 'config.json'))).toMatchObject({
        run_id: 'second-run',
        state_dir: null,
      });

      const backups = readdirSync(workspace).filter((entry) => entry.startsWith('.volley.bak.'));
      expect(backups).toHaveLength(1);
      expect(read_json(join(workspace, backups[0] ?? '', 'config.json'))['run_id']).toBe(
        'first-run',
      );
    } finally {
      cleanup();
    }
  });
});

describe('resolving state_dir', () => {
  const raw = (workspace: string, state_dir: unknown) => ({
    prompt: 'p',
    workspace,
    criteria: 'c',
    check: 'none' as const,
    state_dir: state_dir as string,
  });

  it('resolves a relative root against the cwd, and an unset or empty one to the default root', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const options = { cwd: workspace, env: { XDG_STATE_HOME: STATE_HOME } };
      expect(resolve_config(raw(workspace, 'runs'), options).state_dir).toBe(join(workspace, 'runs'));
      expect(resolve_config(raw(workspace, '  '), options).state_dir).toBe(DEFAULT_ROOT);
      expect(resolve_config(raw(workspace, undefined), options).state_dir).toBe(DEFAULT_ROOT);
      expect(() => resolve_config(raw(workspace, 7), options)).toThrow(
        '--state-dir (state_dir) must be a path string; got a number',
      );
    } finally {
      cleanup();
    }
  });
});

/** Stand-in seats, and a run on them whose round 1 is sent back and whose
 * round 2 builder is stopped mid-phase, which leaves it to resume. The seats
 * are recorded in its config, so the resumed run reaches the stand-ins. */
async function interrupted_run(
  workspace: string,
  overrides: Partial<ResolvedConfig>,
): Promise<{ builder_server: StubOpenAi; critic_server: StubOpenAi }> {
  const builder_server = await stub_openai('done');
  const critic_server = await stub_openai(APPROVED);
  const config = test_config({
    workspace,
    max_iterations: 2,
    builder_provider: 'openrouter',
    builder_model: 'vendor/builder-model',
    builder_url: builder_server.url,
    critic_provider: 'openrouter',
    critic_model: 'vendor/critic-model',
    critic_url: critic_server.url,
    ...overrides,
  });
  const engine = mock_engine((call, index) => {
    if (call.role === 'critic') return reject_reply('not yet');
    return index === 0 ? { content: 'first pass' } : { content: '', error: new aborted_error('sigint') };
  });
  await expect(
    run_volley(config, { renderer: silent_renderer(), engine, install_signal_handlers: false }),
  ).rejects.toThrow();
  return { builder_server, critic_server };
}

/** The resumed run's round 2 was approved, its state in `dir`. */
function expect_resumed(stdout: string, dir: string): void {
  expect(JSON.parse(stdout)).toMatchObject({
    status: 'success',
    iterations_completed: 2,
    run_state_dir: dir,
  });
  expect(read_json(join(dir, 'iterations', '002', 'summary.json'))['verdict']).toBe('approved');
  expect(read_json(join(dir, 'summary.json'))['status']).toBe('success');
}

describe('volley resume <id>', () => {
  it('resumes a run kept under --state-dir, though --workspace defaults elsewhere', async () => {
    const { workspace, cleanup } = temp_workspace();
    const root = temp_root();
    try {
      const seats = await interrupted_run(workspace, { run_id: 'resume-me', state_dir: root });

      // `--workspace` is left at its default, the repo this test runs from.
      const { status, stdout } = await run_cli(['resume', 'resume-me', '--state-dir', root, '--json']);
      expect(status).toBe(EXIT_SUCCESS);
      expect_resumed(stdout, join(root, 'resume-me'));
      expect(seats.builder_server.seen.map((r) => r.model)).toEqual(['vendor/builder-model']);
      expect(seats.critic_server.seen.map((r) => r.model)).toEqual(['vendor/critic-model']);
      expect(existsSync(join(workspace, '.volley'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('finds a run under the default root with no --state-dir, from any directory', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      await interrupted_run(workspace, { run_id: 'default-resume', state_dir: DEFAULT_ROOT });

      const { status, stdout } = await run_cli(['resume', 'default-resume', '--json']);
      expect(status).toBe(EXIT_SUCCESS);
      expect_resumed(stdout, join(DEFAULT_ROOT, 'default-resume'));
    } finally {
      cleanup();
    }
  });

  it("resumes a run an older volley kept in .volley/ there, and leaves the root alone", async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      await interrupted_run(workspace, { run_id: 'legacy-resume' });

      const { status, stdout } = await run_cli([
        'resume',
        'legacy-resume',
        '--workspace',
        workspace,
        '--json',
      ]);
      expect(status).toBe(EXIT_SUCCESS);
      expect_resumed(stdout, join(workspace, '.volley'));
      expect(existsSync(join(DEFAULT_ROOT, 'legacy-resume'))).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe('volley matrix over a base config that sets state_dir', () => {
  it("reads each seat's summary back from the root, while .volley-matrix/ stays in the workspace", async () => {
    // Every model call is refused, so the seat fails after the orchestrator has
    // written its summary, and matrix has to read that summary back to count
    // the attempt rather than mark it broke.
    const server = await start_server((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'refused by the test' } }));
    });
    const url = `${server.origin}/v1`;
    const { workspace, cleanup } = temp_git_workspace();
    const root = temp_root();
    const config_dir = temp_root();
    try {
      const config_path = join(config_dir, 'volley.config.mjs');
      writeFileSync(
        config_path,
        `export default ${JSON.stringify({
          prompt: 'write the file',
          workspace,
          criteria: 'the file exists',
          check: 'none',
          max_iterations: 1,
          builder_provider: 'openrouter',
          builder_url: url,
          critic_provider: 'openrouter',
          critic_url: url,
          allow_unsandboxed_builder: true,
          state_dir: root,
        })};\n`,
      );

      const { status, stdout } = await run_cli([
        'matrix',
        '--config',
        config_path,
        '--builders',
        'vendor/b',
        '--critics',
        'vendor/c',
        '--json',
      ]);
      expect(server.requests).toContain('/v1/chat/completions');
      expect(status).toBe(EXIT_SUCCESS);
      const { combos } = JSON.parse(stdout) as {
        combos: { attempts: { status: string }[] }[];
      };
      expect(combos[0]?.attempts.map((attempt) => attempt.status)).toEqual(['error']);

      const [run_id, ...others] = readdirSync(root);
      expect(others).toEqual([]);
      const persisted = read_json(
        join(workspace, '.volley-matrix', 'vendor_b__vendor_c', 'run-01', 'summary.json'),
      );
      expect(persisted).toMatchObject({ run_id, status: 'error' });
      expect(read_json(join(root, run_id ?? '', 'summary.json'))['status']).toBe('error');
      expect(existsSync(join(workspace, '.volley-matrix', 'matrix.json'))).toBe(true);
      expect(existsSync(join(workspace, '.volley'))).toBe(false);
    } finally {
      cleanup();
    }
  });
});
