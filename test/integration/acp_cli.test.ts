/**
 * `volley acp`, the way an editor meets it. Spawned under tsx, it answers an
 * `initialize` on stdout with nothing else there, and refuses what it can't
 * serve before serving anything. In process, one prompt runs a whole volley
 * turn through fascicle's `acp_agent` and the SDK's client, with both seats on
 * stand-in OpenRouter servers.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acp_agent } from 'fascicle/acp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acp_base_config, acp_serve_config, acp_state_root } from '../../src/acp.js';
import { package_version } from '../../src/cli.js';
import { EXIT_CONFIG_ERROR, EXIT_SUCCESS } from '../../src/exit_codes.js';
import type { ResolvedConfig } from '../../src/types.js';
import { open_session, read_turn } from '../helpers/acp_client.js';
import { temp_workspace } from '../helpers/harness.js';
import { close_servers } from '../helpers/http_server.js';
import { stub_openai } from '../helpers/openai_stub.js';

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
const REPO = fileURLToPath(new URL('../..', import.meta.url));

const KEY = 'sk-or-test';

const SEATS = [
  '--builder-provider',
  'openrouter',
  '--builder-model',
  'vendor/builder-model',
  '--critic-provider',
  'openrouter',
  '--critic-model',
  'vendor/critic-model',
  '--allow-unsandboxed-builder',
];

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: { protocolVersion: 1, clientCapabilities: {} },
};

/** Variables that would decide a seat's key, URL, or containment for the
 * child, so the developer's shell can't. */
const DECIDING_VARS = new Set([
  'OPENROUTER_API_KEY',
  'VOLLEY_OPENROUTER_URL',
  'VOLLEY_CONTAINED',
  'VOLLEY_ALLOW_UNSANDBOXED_BUILDER',
]);

function acp_env(env: Record<string, string>): NodeJS.ProcessEnv {
  const kept = Object.entries(process.env).filter(([name]) => !DECIDING_VARS.has(name));
  return { ...Object.fromEntries(kept), ...env };
}

/** Start `volley acp` with `args` and stdin closed at once: what it prints
 * before it would serve. */
function refused(args: string[], env: Record<string, string> = { OPENROUTER_API_KEY: KEY }) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'acp', ...args], {
    cwd: REPO,
    encoding: 'utf8',
    input: '',
    env: acp_env(env),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Start `volley acp` with `args`, write one `initialize` line, and close
 * stdin once a line comes back, so the agent ends as an editor's would. */
function initialize(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', CLI, 'acp', ...args], {
    cwd: REPO,
    env: acp_env({ OPENROUTER_API_KEY: KEY }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    if (stdout.includes('\n')) child.stdin.end();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdin.write(`${JSON.stringify(INITIALIZE)}\n`);
  return new Promise((resolve) => {
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

describe('volley acp, spawned', () => {
  it('answers one initialize with exactly one JSON-RPC response on stdout, naming volley at its version', async () => {
    const { code, stdout, stderr } = await initialize(SEATS);

    expect(code, stderr).toBe(EXIT_SUCCESS);
    const lines = stdout.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      jsonrpc: '2.0',
      id: 0,
      result: { agentInfo: { name: 'volley', version: package_version() } },
    });
  });

  it('accepts a claude_cli critic beside a tool-loop builder', async () => {
    const seats = [
      ...SEATS.slice(0, 4),
      '--critic-provider',
      'claude_cli',
      '--critic-model',
      'opus',
      '--allow-unsandboxed-builder',
    ];
    const { code, stdout, stderr } = await initialize(seats);

    expect(code, stderr).toBe(EXIT_SUCCESS);
    expect(JSON.parse(stdout)).toMatchObject({ id: 0, result: { agentInfo: { name: 'volley' } } });
  });

  it.each([
    ['--worktree', 'volley acp refuses --worktree: a sibling worktree sits outside the project'],
    ['--git', 'volley acp refuses --git: it commits to the open repo after every phase'],
    ['--json', 'volley acp refuses --json: stdout carries the protocol alone'],
  ])('refuses %s with its reason before serving', (flag, reason) => {
    const { status, stdout, stderr } = refused([...SEATS, flag]);

    expect(status).toBe(EXIT_CONFIG_ERROR);
    expect(stderr).toContain(reason);
    expect(stdout).toBe('');
  });

  it('refuses a claude_cli builder with its reason before serving', () => {
    const seats = ['--builder-provider', 'claude_cli', '--builder-model', 'opus', ...SEATS.slice(4)];
    const { status, stdout, stderr } = refused(seats);

    expect(status).toBe(EXIT_CONFIG_ERROR);
    expect(stderr).toContain(
      'volley acp refuses a claude_cli builder: the Claude CLI runs its own tools under its own permission model',
    );
    expect(stdout).toBe('');
  });

  it('names every missing seat flag in one refusal', () => {
    const { status, stdout, stderr } = refused([
      '--builder-provider',
      'openrouter',
      '--allow-unsandboxed-builder',
    ]);

    expect(status).toBe(EXIT_CONFIG_ERROR);
    expect(stderr).toContain(
      'volley acp requires every seat flag, and these are missing: --builder-model, --critic-provider, --critic-model',
    );
    expect(stdout).toBe('');
  });

  it('refuses at startup when OPENROUTER_API_KEY is unset', () => {
    const { status, stdout, stderr } = refused(SEATS, {});

    expect(status).toBe(EXIT_CONFIG_ERROR);
    expect(stderr).toContain('OPENROUTER_API_KEY is not set');
    expect(stdout).toBe('');
  });
});

describe('acp_base_config', () => {
  const seats = {
    builder_provider: 'openrouter',
    builder_model: 'vendor/builder-model',
    critic_provider: 'openrouter',
    critic_model: 'vendor/critic-model',
    allow_unsandboxed_builder: true,
  } as const;
  const env = { OPENROUTER_API_KEY: KEY, XDG_STATE_HOME: '/state' };

  it('caps a prompt at 3 rounds unless --max-iterations says otherwise', () => {
    expect(acp_base_config(seats, env).max_iterations).toBe(3);
    expect(acp_base_config({ ...seats, max_iterations: 7 }, env).max_iterations).toBe(7);
  });

  it('keeps state under XDG_STATE_HOME, else ~/.local/state, unless --state-dir names a root', () => {
    expect(acp_base_config(seats, env).state_dir).toBe('/state/volley');
    expect(acp_base_config({ ...seats, state_dir: '/elsewhere' }, env).state_dir).toBe('/elsewhere');
    expect(acp_state_root({})).toBe(join(homedir(), '.local', 'state', 'volley'));
    expect(acp_state_root({ XDG_STATE_HOME: 'relative' })).toBe(join(homedir(), '.local', 'state', 'volley'));
  });
});

describe('one prompt through acp_agent and the SDK client', () => {
  const APPROVED = JSON.stringify({
    verdict: 'approved',
    feedback: 'Looks good.',
    unmet_criteria: [],
  });
  let state_home = '';

  beforeEach(() => {
    state_home = mkdtempSync(join(tmpdir(), 'volley-acp-state-'));
    // The engines read the key and their endpoints from the process.
    vi.stubEnv('OPENROUTER_API_KEY', KEY);
    vi.stubEnv('VOLLEY_OPENROUTER_URL', '');
    vi.stubEnv('VOLLEY_MODEL_HOST', '');
    vi.stubEnv('VOLLEY_PRICING_PATH', '');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await close_servers();
    rmSync(state_home, { recursive: true, force: true });
  });

  it("ends end_turn with the builder's text as the reply, and leaves no .volley in the workspace", async () => {
    const builder_server = await stub_openai('Wrote the file.');
    const critic_server = await stub_openai(APPROVED);
    const { workspace, cleanup } = temp_workspace();
    const stdout = vi.spyOn(process.stdout, 'write');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const env = { OPENROUTER_API_KEY: KEY, XDG_STATE_HOME: state_home };
      const base = acp_base_config(
        {
          builder_provider: 'openrouter',
          builder_model: 'vendor/builder-model',
          builder_url: builder_server.url,
          critic_provider: 'openrouter',
          critic_model: 'vendor/critic-model',
          critic_url: critic_server.url,
          check: 'none',
          allow_unsandboxed_builder: true,
        },
        env,
      );
      const app = await acp_agent(acp_serve_config(base, { version: '1.2.3', env }));
      const session = await open_session(app, workspace);

      await session.prompt('write the file');
      const turn = await read_turn(session);

      expect(turn.stop_reason).toBe('end_turn');
      expect(turn.updates).toEqual([
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Wrote the file.' } },
      ]);
      expect(builder_server.seen.map(({ model }) => model)).toEqual(['vendor/builder-model']);
      expect(critic_server.seen.map(({ model }) => model)).toEqual(['vendor/critic-model']);

      expect(existsSync(join(workspace, '.volley'))).toBe(false);
      const runs = readdirSync(join(state_home, 'volley'));
      expect(runs).toHaveLength(1);
      const config = JSON.parse(
        readFileSync(join(state_home, 'volley', runs[0] ?? '', 'config.json'), 'utf8'),
      ) as ResolvedConfig;
      expect(config).toMatchObject({
        workspace,
        prompt: 'write the file',
        criteria: 'write the file',
        max_iterations: 3,
        state_dir: join(state_home, 'volley'),
      });
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});
