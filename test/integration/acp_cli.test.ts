/**
 * `volley acp`, the way an editor meets it. Spawned under tsx, it answers an
 * `initialize` on stdout with nothing else there, and refuses what it can't
 * serve before serving anything. In process, a session offers Auto only in a
 * container or with the opt-out, and takes no folder beside its own; one
 * prompt runs a whole volley turn through fascicle's `acp_agent` and the SDK's
 * client, with both seats on stand-in OpenRouter servers, and the check asks
 * on its card first whenever a builder command would.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  RequestPermissionRequest,
  SessionModeId,
  SessionModeState,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import { acp_agent } from 'fascicle/acp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acp_base_config, acp_serve_config, acp_state_root } from '../../src/acp.js';
import { CHECK_REJECTED } from '../../src/check/command.js';
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
    const response = JSON.parse(lines[0] ?? '') as {
      result: { agentCapabilities: { sessionCapabilities?: Record<string, unknown> } };
    };
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 0,
      result: { agentInfo: { name: 'volley', version: package_version() } },
    });
    // A client that follows the protocol sends no folders beside cwd.
    expect(response.result.agentCapabilities.sessionCapabilities).not.toHaveProperty(
      'additionalDirectories',
    );
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

  it('serves an uncontained builder with no opt-out, whose commands will each ask instead', () => {
    expect(acp_base_config({ ...seats, allow_unsandboxed_builder: false }, env).builder_provider).toBe(
      'openrouter',
    );
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

  /** volley's agent, served in process with each seat on its own stub, and
   * one session open on `workspace`. */
  async function serve(builder_url: string, critic_url: string, workspace: string) {
    const env = { OPENROUTER_API_KEY: KEY, XDG_STATE_HOME: state_home };
    const base = acp_base_config(
      {
        builder_provider: 'openrouter',
        builder_model: 'vendor/builder-model',
        builder_url,
        critic_provider: 'openrouter',
        critic_model: 'vendor/critic-model',
        critic_url,
        check: 'none',
        allow_unsandboxed_builder: true,
      },
      env,
    );
    const app = await acp_agent(acp_serve_config(base, { version: '1.2.3', env }));
    return open_session(app, workspace);
  }

  /** Each run's recorded config under the acp state root, oldest first. */
  function run_configs(): ResolvedConfig[] {
    const root = join(state_home, 'volley');
    return readdirSync(root)
      .map((run) => JSON.parse(readFileSync(join(root, run, 'config.json'), 'utf8')) as ResolvedConfig)
      .toSorted((a, b) => a.started_at.localeCompare(b.started_at));
  }

  const text = (sessionUpdate: string, value: string) => ({
    sessionUpdate,
    content: { type: 'text', text: value },
  });

  it("ends end_turn with the round, the builder's text, the verdict, and the summary, and leaves no .volley in the workspace", async () => {
    const builder_server = await stub_openai('Wrote the file.');
    const critic_server = await stub_openai(APPROVED);
    const { workspace, cleanup } = temp_workspace();
    const stdout = vi.spyOn(process.stdout, 'write');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const session = await serve(builder_server.url, critic_server.url, workspace);

      await session.prompt('write the file');
      const turn = await read_turn(session);

      expect(turn.stop_reason).toBe('end_turn');
      expect(turn.updates).toEqual([
        text('agent_message_chunk', '**Round 1**\n\n'),
        text('agent_message_chunk', 'Wrote the file.'),
        text('agent_thought_chunk', '\n\n**Round 1 verdict: approved**\n\nLooks good.'),
        text('agent_message_chunk', '\n\n**Converged** in 1 round. Last verdict: approved.'),
      ]);
      expect(builder_server.seen.map(({ model }) => model)).toEqual(['vendor/builder-model']);
      expect(critic_server.seen.map(({ model }) => model)).toEqual(['vendor/critic-model']);

      expect(existsSync(join(workspace, '.volley'))).toBe(false);
      const configs = run_configs();
      expect(configs).toHaveLength(1);
      expect(configs[0]).toMatchObject({
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

  it('ends a failed run with a summary saying so, which the next prompt reads back', async () => {
    const builder_server = await stub_openai('Wrote the file.');
    const critic_server = await stub_openai('not a verdict');
    const { workspace, cleanup } = temp_workspace();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const session = await serve(builder_server.url, critic_server.url, workspace);

      await session.prompt('write the file');
      const failed = await read_turn(session);

      expect(failed.stop_reason).toBe('end_turn');
      const last = failed.updates.at(-1);
      expect(last).toMatchObject({ sessionUpdate: 'agent_message_chunk' });
      const summary = last?.sessionUpdate === 'agent_message_chunk' && last.content.type === 'text'
        ? last.content.text
        : '';
      expect(summary).toMatch(/^\n\n\*\*Run failed\*\* in round 1, during the critique: ./);

      await session.prompt('try again');
      await read_turn(session);

      const retry = run_configs()[1];
      expect(retry?.prompt).toBe(
        [
          'The conversation so far, oldest first:',
          'User: write the file',
          `Volley: **Round 1**\n\nWrote the file.${summary}`,
          'The request now:',
          'try again',
        ].join('\n\n'),
      );
      expect(retry?.criteria).toBe(retry?.prompt);
    } finally {
      cleanup();
    }
  });

  describe('the modes and the folders a session takes', () => {
    /** volley's agent, served in process with its seats' servers unused,
     * contained or not, opted out or not. An app serves one connection, so
     * each session gets its own. */
    async function app_for(options: { contained: boolean; opted_out: boolean }) {
      const env = {
        OPENROUTER_API_KEY: KEY,
        XDG_STATE_HOME: state_home,
        ...(options.contained ? { VOLLEY_CONTAINED: '1' } : {}),
      };
      const base = acp_base_config(
        {
          builder_provider: 'openrouter',
          builder_model: 'vendor/builder-model',
          critic_provider: 'openrouter',
          critic_model: 'vendor/critic-model',
          allow_unsandboxed_builder: options.opted_out,
        },
        env,
      );
      return acp_agent(acp_serve_config(base, { version: '1.2.3', env }));
    }

    const mode_ids = (session: { modes: SessionModeState | null | undefined }) =>
      session.modes?.availableModes.map(({ id }) => id);

    it('offers Manual and Accept edits alone uncontained with no opt-out, and refuses a switch to Auto', async () => {
      const { workspace, cleanup } = temp_workspace();
      const host = { contained: false, opted_out: false };
      try {
        const session = await open_session(await app_for(host), workspace, { mode: 'accept_edits' });
        expect(mode_ids(session)).toEqual(['manual', 'accept_edits']);
        expect(session.modes?.currentModeId).toBe('manual');

        await expect(open_session(await app_for(host), workspace, { mode: 'auto' })).rejects.toMatchObject({
          code: -32602,
        });
      } finally {
        cleanup();
      }
    });

    it.each([
      ['contained', { contained: true, opted_out: false }],
      ['opted out', { contained: false, opted_out: true }],
    ])('offers all three modes %s, Auto included', async (_, options) => {
      const { workspace, cleanup } = temp_workspace();
      try {
        const session = await open_session(await app_for(options), workspace, { mode: 'auto' });
        expect(mode_ids(session)).toEqual(['manual', 'accept_edits', 'auto']);
      } finally {
        cleanup();
      }
    });

    it('refuses a session/new that sends a folder beside cwd', async () => {
      const { workspace, cleanup } = temp_workspace();
      const extra = mkdtempSync(join(tmpdir(), 'volley-acp-extra-'));
      try {
        const app = await app_for({ contained: true, opted_out: false });
        await expect(
          open_session(app, workspace, { additional_directories: [extra] }),
        ).rejects.toMatchObject({ code: -32602 });
      } finally {
        cleanup();
        rmSync(extra, { recursive: true, force: true });
      }
    });
  });

  describe('the check, asking first', () => {
    /** The check's command: it prints the environment it ran with. */
    const CHECK = 'env > check_env.txt';

    type CheckedTurn = {
      requests: RequestPermissionRequest[];
      updates: SessionUpdate[];
      /** What the check printed, or null when it never ran. */
      check_env: string | null;
    };

    /** One prompt in `mode` with the check `CHECK`, no opt-out from the
     * sandbox, both seats' keys in the agent's environment, and each
     * permission request answered `answer`. */
    async function checked_turn(options: {
      mode: SessionModeId;
      contained: boolean;
      answer: 'allow_once' | 'reject_once';
    }): Promise<CheckedTurn> {
      const builder_server = await stub_openai('Wrote the file.');
      const critic_server = await stub_openai(APPROVED);
      const { workspace, cleanup } = temp_workspace();
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const env = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        OPENROUTER_API_KEY: KEY,
        ANTHROPIC_API_KEY: 'sk-ant-test',
        VOLLEY_ACP_AGENT_MARK: 'agent-env',
        XDG_STATE_HOME: state_home,
        ...(options.contained ? { VOLLEY_CONTAINED: '1' } : {}),
      };
      try {
        const base = acp_base_config(
          {
            builder_provider: 'openrouter',
            builder_model: 'vendor/builder-model',
            builder_url: builder_server.url,
            critic_provider: 'openrouter',
            critic_model: 'vendor/critic-model',
            critic_url: critic_server.url,
            check: CHECK,
            max_iterations: 1,
          },
          env,
        );
        const app = await acp_agent(acp_serve_config(base, { version: '1.2.3', env }));
        const requests: RequestPermissionRequest[] = [];
        const session = await open_session(app, workspace, {
          mode: options.mode,
          on_permission: (request) => {
            requests.push(request);
            return { outcome: { outcome: 'selected', optionId: options.answer } };
          },
        });
        await session.prompt('write the file');
        const { updates } = await read_turn(session);
        const printed = join(workspace, 'check_env.txt');
        return { requests, updates, check_env: existsSync(printed) ? readFileSync(printed, 'utf8') : null };
      } finally {
        cleanup();
      }
    }

    /** The check's card as it opened, and the update that closed it. */
    function check_card(updates: SessionUpdate[]) {
      const opened = updates.find(
        (update) => update.sessionUpdate === 'tool_call' && update.kind === 'execute',
      );
      const id = opened?.sessionUpdate === 'tool_call' ? opened.toolCallId : undefined;
      const closed = updates.findLast(
        (update) => update.sessionUpdate === 'tool_call_update' && update.toolCallId === id,
      );
      return { id, closed };
    }

    it('asks uncontained in Accept edits, on its own card, offering Allow and Reject alone', async () => {
      const { requests, updates, check_env } = await checked_turn({
        mode: 'accept_edits',
        contained: false,
        answer: 'allow_once',
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]?.options).toEqual([
        { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ]);
      const card = check_card(updates);
      expect(card.id).toBeDefined();
      expect(requests[0]?.toolCall).toMatchObject({
        toolCallId: card.id,
        title: CHECK,
        rawInput: { command: CHECK },
      });
      expect(card.closed).toMatchObject({ status: 'completed' });
      // It ran with the agent's environment, PATH kept, less both seats' keys.
      expect(check_env).toContain('VOLLEY_ACP_AGENT_MARK=agent-env');
      expect(check_env).toContain(`PATH=${process.env.PATH ?? '/usr/bin:/bin'}`);
      expect(check_env).not.toContain('OPENROUTER_API_KEY');
      expect(check_env).not.toContain('ANTHROPIC_API_KEY');
    });

    it('records a rejected check as failed, closing its card with the refusal, and never runs it', async () => {
      const { requests, updates, check_env } = await checked_turn({
        mode: 'accept_edits',
        contained: false,
        answer: 'reject_once',
      });

      expect(requests).toHaveLength(1);
      expect(check_env).toBeNull();
      expect(check_card(updates).closed).toMatchObject({
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: CHECK_REJECTED } }],
      });
      // The critic approved, but nothing checked the work.
      expect(updates.at(-1)).toMatchObject({
        sessionUpdate: 'agent_message_chunk',
        content: { text: expect.stringContaining('**Not converged** after 1 round') },
      });
    });

    it('follows the mode once contained: no prompt in Auto, a prompt in Manual', async () => {
      const auto = await checked_turn({ mode: 'auto', contained: true, answer: 'reject_once' });
      expect(auto.requests).toHaveLength(0);
      expect(auto.check_env).not.toBeNull();

      const manual = await checked_turn({ mode: 'manual', contained: true, answer: 'allow_once' });
      expect(manual.requests).toHaveLength(1);
      expect(manual.check_env).not.toBeNull();
    });
  });
});
