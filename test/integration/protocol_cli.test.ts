/**
 * `volley run --protocol runciter.run/1` (move 1's step 10): one RunInput on
 * stdin, exactly one RunOutput on stdout and nothing else, runciter's typed
 * lines on stderr, and the protocol's exit codes. The run itself goes through
 * `serve_protocol` on the mock engine; the refusals, the environment that
 * changes nothing, and one whole run on the stand-in `claude` go through the
 * CLI as a child process.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { provider_error } from 'fascicle';
import {
  EXIT_CONFIG_ERROR,
  PROTOCOL_EXIT_CONTRACT_VIOLATION,
  PROTOCOL_EXIT_OUTPUT,
} from '../../src/exit_codes.js';
import { run_output_schema, serve_protocol } from '../../src/protocol/index.js';
import type { ProtocolIo } from '../../src/protocol/index.js';
import { create_renderer } from '../../src/render/renderer.js';
import type { ResolvedConfig } from '../../src/types.js';
import { cli_env } from '../helpers/cli.js';
import type { CliResult } from '../helpers/cli.js';
import { install_fake_claude } from '../helpers/fake_claude.js';
import { approve_reply, mock_engine, reject_reply } from '../helpers/mock_engine.js';
import type { MockReply } from '../helpers/mock_engine.js';

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
const INPUT_FIXTURE = fileURLToPath(new URL('../fixtures/runciter_run_input.json', import.meta.url));

let root = '';
let workspace = '';
let run_dir = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'volley-protocol-cli-'));
  workspace = join(root, 'work');
  run_dir = join(root, 'run');
  mkdirSync(workspace);
  mkdirSync(join(run_dir, 'artifacts'), { recursive: true });
  writeFileSync(join(run_dir, 'context.md'), '## Task\n\nTitle: Write done.txt\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The conformance fixture, pointed at this test's workspace and run
 * directory, with the stage's verify as the check. */
function run_input(verify = 'test -f done.txt'): Record<string, unknown> {
  const input = JSON.parse(readFileSync(INPUT_FIXTURE, 'utf8')) as Record<string, Record<string, unknown>>;
  return {
    ...input,
    stage: { ...input['stage'], verify },
    workspace: { ...input['workspace'], path: workspace },
    run_dir,
    context: { markdown_path: join(run_dir, 'context.md'), pack_path: join(run_dir, 'context-pack.json') },
  };
}

type Served = { code: number; stdout: string; stderr: string };

/** `serve_protocol` over captured streams, the run's seats on `replies`. */
async function serve(
  stdin: string,
  replies: (role: 'builder' | 'critic', index: number) => MockReply,
  argv: { flags?: Record<string, unknown>; positionals?: string[] } = {},
): Promise<Served> {
  let stdout = '';
  let stderr = '';
  const io: ProtocolIo = {
    read_input: () => Promise.resolve(stdin),
    write_output: (chunk) => {
      stdout += chunk;
      return Promise.resolve();
    },
    write_error: (chunk) => {
      stderr += chunk;
    },
  };
  const engine = mock_engine((call, index) => replies(call.role, index));
  const code = await serve_protocol(
    { read_flags: () => Promise.resolve({ ...argv.flags }), positionals: argv.positionals ?? [] },
    io,
    {
      renderer_for: (config: ResolvedConfig) =>
        create_renderer({
          mode: 'protocol',
          show_thinking: false,
          color: false,
          max_cost_usd: config.max_cost_usd,
          max_iterations: config.max_iterations,
          write: (text) => {
            stderr += text;
          },
        }),
      engine,
      install_signal_handlers: false,
      env: {},
    },
  );
  return { code, stdout, stderr };
}

const builds_done = (): MockReply => ({
  content: 'wrote done.txt',
  cost_usd: 0.25,
  effect: () => writeFileSync(join(workspace, 'done.txt'), 'done\n'),
});

/** Every stderr line that parses as JSON with a `type`. */
function typed_lines(stderr: string): Array<Record<string, unknown>> {
  return stderr
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => typeof line['type'] === 'string');
}

/** The one RunOutput on stdout, refusing anything more. */
function one_output(stdout: string): ReturnType<typeof run_output_schema.parse> {
  const lines = stdout.split('\n').filter((line) => line.length > 0);
  expect(lines).toHaveLength(1);
  return run_output_schema.parse(JSON.parse(lines[0] ?? ''));
}

/** The last non-blank stderr line, as runciter reads a failure's detail. */
function last_failure(stderr: string): Record<string, unknown> {
  const last = stderr.split('\n').filter((line) => line.trim() !== '').at(-1) ?? '';
  return JSON.parse(last) as Record<string, unknown>;
}

describe('volley run --protocol runciter.run/1, on the mock engine', () => {
  it('writes one passed RunOutput, keeps its state in the run directory, and copies the feedback out', async () => {
    const served = await serve(JSON.stringify(run_input()), (role) =>
      role === 'builder' ? builds_done() : approve_reply('All criteria met.'),
    );
    expect(served.code).toBe(PROTOCOL_EXIT_OUTPUT);
    const output = one_output(served.stdout);
    expect(output.status).toBe('passed');
    expect(output.summary).toBe('volley: success after 1 iteration, verdict approved.\n\nAll criteria met.');
    expect(output.artifacts).toEqual([
      { name: 'critic-feedback.md', path: 'critic-feedback.md', media_type: 'text/markdown', title: 'Critic feedback' },
    ]);
    expect(output.lessons).toEqual([]);
    expect(output.usage?.cost_source).toBe('estimated');
    expect(output.data).toMatchObject({ run_id: '01JCZ7Q3V8M2K4T6R9X0B5N1HD', status: 'success' });

    expect(readFileSync(join(run_dir, 'artifacts', 'critic-feedback.md'), 'utf8')).toBe('All criteria met.\n');
    const state = join(run_dir, 'volley', '01JCZ7Q3V8M2K4T6R9X0B5N1HD');
    expect(existsSync(join(state, 'summary.json'))).toBe(true);
    // Only the builder's work is in the workspace runciter diffs.
    expect(readdirSync(workspace)).toEqual(['done.txt']);
  });

  it('says each phase as runciter.progress, and ends on runciter.usage with the tokens', async () => {
    const served = await serve(JSON.stringify(run_input()), (role) =>
      role === 'builder' ? builds_done() : approve_reply(),
    );
    const lines = typed_lines(served.stderr);
    const progress = lines.filter((line) => line['type'] === 'runciter.progress');
    expect(progress.map((line) => line['message'])).toEqual([
      'iteration 1: builder',
      'iteration 1: builder done',
      'iteration 1: check',
      'iteration 1: check done',
      'iteration 1: critic',
      'iteration 1: critic approved',
    ]);
    expect(progress.every((line) => line['done'] === 0 && line['total'] === 10)).toBe(true);
    const usage = lines.filter((line) => line['type'] === 'runciter.usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ cost_usd: 0.3, input_tokens: 2000, output_tokens: 400 });
  });

  it('gives each iteration its runciter.usage line, the running total', async () => {
    const served = await serve(JSON.stringify(run_input()), (role, index) => {
      if (role === 'builder') return builds_done();
      return index === 1 ? reject_reply('Also log it.') : approve_reply();
    });
    expect(served.code).toBe(PROTOCOL_EXIT_OUTPUT);
    expect(one_output(served.stdout).status).toBe('passed');
    const usage = typed_lines(served.stderr).filter((line) => line['type'] === 'runciter.usage');
    expect(usage).toHaveLength(2);
    expect(usage[0]?.['cost_usd']).toBeCloseTo(0.3);
    expect(usage[1]?.['cost_usd']).toBeCloseTo(0.6);
    // Only the last, after the run, carries the tokens.
    expect(usage[0]).not.toHaveProperty('input_tokens');
    expect(usage[1]).toHaveProperty('input_tokens');
    const iteration_two = typed_lines(served.stderr).find((line) => line['message'] === 'iteration 2: builder');
    expect(iteration_two).toMatchObject({ done: 1, total: 10 });
  });

  it('exits 0 on a builder error, with a failed RunOutput that names it', async () => {
    const served = await serve(JSON.stringify(run_input()), (role) =>
      role === 'builder' ? { content: '', error: new provider_error('the model went away') } : approve_reply(),
    );
    expect(served.code).toBe(PROTOCOL_EXIT_OUTPUT);
    const output = one_output(served.stdout);
    expect(output.status).toBe('failed');
    expect(output.fail_reason).toBe('builder_error');
    expect(output.detail).toContain('the model went away');
    expect(output.data).toMatchObject({ status: 'error' });
    expect(output).not.toHaveProperty('artifacts');
  });

  it('says iterations_exhausted when the critic never approves', async () => {
    const served = await serve(
      JSON.stringify(run_input()),
      (role) => (role === 'builder' ? builds_done() : reject_reply('Not yet.')),
      { flags: { max_iterations: 2 } },
    );
    expect(served.code).toBe(PROTOCOL_EXIT_OUTPUT);
    const output = one_output(served.stdout);
    expect(output).toMatchObject({ status: 'failed', fail_reason: 'iterations_exhausted' });
    expect(output.summary).toContain('Not yet.');
  });

  it('exits 2 with nothing on stdout for stdin that is not a RunInput, naming the field', async () => {
    const { run_dir: _gone, ...without_run_dir } = run_input();
    const served = await serve(JSON.stringify(without_run_dir), () => approve_reply());
    expect(served.code).toBe(PROTOCOL_EXIT_CONTRACT_VIOLATION);
    expect(served.stdout).toBe('');
    expect(last_failure(served.stderr)).toMatchObject({ stage: 'validate_input' });
    expect(String(last_failure(served.stderr)['error'])).toContain('run_dir');
  });

  it('exits 2 for an input volley cannot run, a workspace that is not there', async () => {
    const input = run_input();
    const served = await serve(
      JSON.stringify({ ...input, workspace: { ...(input['workspace'] as object), path: join(root, 'missing') } }),
      () => approve_reply(),
    );
    expect(served.code).toBe(PROTOCOL_EXIT_CONTRACT_VIOLATION);
    expect(served.stdout).toBe('');
    expect(String(last_failure(served.stderr)['error'])).toContain(join(root, 'missing'));
  });

  it('refuses a positional prompt and each workspace flag before reading stdin', async () => {
    const cases: Array<[{ flags?: Record<string, unknown>; positionals?: string[] }, string]> = [
      [{ positionals: ['build', 'it'] }, 'a positional prompt (build it)'],
      [{ flags: { worktree: true } }, '--worktree (worktree)'],
      [{ flags: { git_checkpoints: true } }, '--git (git_checkpoints)'],
      [{ flags: { json: true } }, '--json (json)'],
    ];
    for (const [argv, named] of cases) {
      const served = await serve('not read', () => approve_reply(), argv);
      expect(served.code, named).toBe(PROTOCOL_EXIT_CONTRACT_VIOLATION);
      expect(served.stdout, named).toBe('');
      expect(String(last_failure(served.stderr)['error']), named).toContain(`protocol mode refuses ${named}`);
    }
  });
});

/** The CLI as a child, with `stdin` written and closed, or left open. */
function spawn_protocol(args: string[], stdin: string | null, env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], { env });
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
    if (stdin !== null) child.stdin.end(stdin);
  });
}

const PROTOCOL_ARGS = ['run', '--protocol', 'runciter.run/1'];

describe('volley run --protocol runciter.run/1, from the command line', () => {
  it('refuses --worktree, --git, --json and a positional prompt with exit 2 and a StdioFailure line', async () => {
    const results = await Promise.all(
      [['--worktree'], ['--git'], ['--json'], ['write', 'the', 'file']].map((extra) =>
        spawn_protocol([...PROTOCOL_ARGS, ...extra], JSON.stringify(run_input()), cli_env()),
      ),
    );
    for (const result of results) {
      expect(result.status).toBe(PROTOCOL_EXIT_CONTRACT_VIOLATION);
      expect(result.stdout).toBe('');
      expect(String(last_failure(result.stderr)['error'])).toMatch(/^protocol mode refuses /);
    }
  });

  it('exits 2 on stdin that is not JSON', async () => {
    const result = await spawn_protocol(PROTOCOL_ARGS, 'not json', cli_env());
    expect(result.status).toBe(PROTOCOL_EXIT_CONTRACT_VIOLATION);
    expect(result.stdout).toBe('');
    expect(last_failure(result.stderr)).toMatchObject({ stage: 'parse' });
  });

  it('changes nothing for RUNCITER_PROTOCOL in the environment alone, and never waits on stdin', async () => {
    const result = await spawn_protocol(['run'], null, cli_env({ RUNCITER_PROTOCOL: 'runciter.run/1' }));
    expect(result.status).toBe(EXIT_CONFIG_ERROR);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('missing required option: --prompt');
  });

  it('runs a task through on the stand-in claude: one RunOutput on stdout, passed', async () => {
    const fake = install_fake_claude();
    try {
      const result = await spawn_protocol(
        PROTOCOL_ARGS,
        JSON.stringify(run_input('test -f claude-was-here.txt')),
        cli_env({ VOLLEY_CLAUDE_BIN: fake.bin }),
      );
      expect(result.status, result.stderr).toBe(PROTOCOL_EXIT_OUTPUT);
      const output = one_output(result.stdout);
      expect(output).toMatchObject({ status: 'passed', artifacts: [{ name: 'critic-feedback.md' }] });
      expect(fake.calls().map((call) => call.role)).toEqual(['builder', 'critic']);
      expect(typed_lines(result.stderr).some((line) => line['type'] === 'runciter.progress')).toBe(true);
    } finally {
      fake.remove();
    }
  });

  it('exits 0 with a failed RunOutput when the claude builder dies', async () => {
    const bin_dir = mkdtempSync(join(tmpdir(), 'volley-dead-claude-'));
    const bin = join(bin_dir, 'claude.mjs');
    writeFileSync(bin, "#!/usr/bin/env node\nprocess.stderr.write('claude: out of cheese\\n');\nprocess.exit(1);\n");
    chmodSync(bin, 0o755);
    try {
      const result = await spawn_protocol(PROTOCOL_ARGS, JSON.stringify(run_input()), cli_env({ VOLLEY_CLAUDE_BIN: bin }));
      expect(result.status, result.stderr).toBe(PROTOCOL_EXIT_OUTPUT);
      expect(one_output(result.stdout)).toMatchObject({ status: 'failed', fail_reason: 'builder_error' });
    } finally {
      rmSync(bin_dir, { recursive: true, force: true });
    }
  });
});
