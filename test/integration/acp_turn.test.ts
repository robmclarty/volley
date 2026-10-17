/**
 * One whole volley turn, the way an editor sees it: volley's acp config
 * served through fascicle's `acp_agent` to the SDK's own client, with both
 * seats on real engines against stand-in OpenRouter servers. The builder's
 * server scripts its calls: an edit the user allows, a command the user
 * rejects, then `finish`. The session stays in Manual, where it starts, and
 * volley runs uncontained with no opt-out, as a bare `volley acp` does, so
 * every call that acts asks first, the check included.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestPermissionRequest, SessionUpdate } from '@agentclientprotocol/sdk';
import { acp_agent } from 'fascicle/acp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acp_base_config, acp_serve_config } from '../../src/acp.js';
import { answer_in_order, open_session, read_turn } from '../helpers/acp_client.js';
import { temp_workspace } from '../helpers/harness.js';
import { close_servers } from '../helpers/http_server.js';
import { stub_openai } from '../helpers/openai_stub.js';
import type { StubTurn } from '../helpers/openai_stub.js';

const KEY = 'sk-or-test';

/** The check: it prints the file the builder wrote, and leaves a mark that
 * shows when it ran. */
const CHECK = 'cat hello.txt && touch checked.txt';

const WRITE = { path: 'hello.txt', content: 'hello\n' };
const RUN = { command: 'touch ran.txt' };
const FINISH = { summary: 'Wrote hello.txt; the command was refused.' };

const BUILDER_SCRIPT: StubTurn[] = [
  { text: 'Writing hello.txt.', tool_call: { id: 'call_write', name: 'write_file', input: WRITE } },
  { tool_call: { id: 'call_run', name: 'run_command', input: RUN } },
  { tool_call: { id: 'call_finish', name: 'finish', input: FINISH } },
];

const APPROVED = JSON.stringify({ verdict: 'approved', feedback: 'Looks good.', unmet_criteria: [] });

const ALLOW = { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' };
const REJECT = { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' };

function message(text: string): SessionUpdate {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } };
}

function thought(text: string): SessionUpdate {
  return { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } };
}

function text_content(text: string) {
  return [{ type: 'content', content: { type: 'text', text } }];
}

/** A card's three updates: opened pending, its input in, then closed. */
function card(
  id: string | undefined,
  opened: { title: string; kind: string },
  input: Record<string, unknown>,
  closed: unknown,
): unknown[] {
  return [
    { sessionUpdate: 'tool_call', toolCallId: id, status: 'pending', ...opened },
    { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress', ...input },
    closed,
  ];
}

describe('a whole volley turn through acp_agent and the SDK client', () => {
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

  it('asks before each act, lands the allowed edit, refuses the rejected command, checks, and ends with the summary', async () => {
    const builder_server = await stub_openai(BUILDER_SCRIPT);
    const critic_server = await stub_openai(APPROVED);
    const { workspace, cleanup } = temp_workspace();
    const stdout = vi.spyOn(process.stdout, 'write');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const in_workspace = (name: string) => join(workspace, name);
    try {
      const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', OPENROUTER_API_KEY: KEY, XDG_STATE_HOME: state_home };
      const base = acp_base_config(
        {
          builder_provider: 'openrouter',
          builder_model: 'vendor/builder-model',
          builder_url: builder_server.url,
          critic_provider: 'openrouter',
          critic_model: 'vendor/critic-model',
          critic_url: critic_server.url,
          check: CHECK,
        },
        env,
      );
      const app = await acp_agent(acp_serve_config(base, { version: '1.2.3', env }));
      const permissions = answer_in_order(['allow_once', 'reject_once', 'allow_once']);
      // What each act had left on disk when it asked: nothing yet.
      const marks = ['hello.txt', 'ran.txt', 'checked.txt'];
      const on_disk_when_asked: string[][] = [];
      const session = await open_session(app, workspace, {
        on_permission: (request: RequestPermissionRequest) => {
          on_disk_when_asked.push(marks.filter((name) => existsSync(in_workspace(name))));
          return permissions.on_permission(request);
        },
      });

      await session.prompt('write hello.txt');
      const turn = await read_turn(session);

      expect(turn.stop_reason).toBe('end_turn');
      const ids = turn.updates.flatMap((update) =>
        update.sessionUpdate === 'tool_call' ? [update.toolCallId] : [],
      );
      expect(new Set(ids).size).toBe(4);
      const [write, run, finish, check] = ids;
      expect(turn.updates).toEqual([
        message('**Round 1**\n\n'),
        message('Writing hello.txt.'),
        ...card(
          write,
          { title: 'write_file', kind: 'edit' },
          { title: 'Write hello.txt', locations: [{ path: in_workspace('hello.txt') }], rawInput: WRITE },
          expect.objectContaining({
            sessionUpdate: 'tool_call_update',
            toolCallId: write,
            status: 'completed',
            rawOutput: 'created hello.txt',
          }),
        ),
        ...card(
          run,
          { title: 'run_command', kind: 'execute' },
          { title: RUN.command, rawInput: RUN },
          {
            sessionUpdate: 'tool_call_update',
            toolCallId: run,
            status: 'failed',
            content: text_content('tool_approval_denied'),
          },
        ),
        ...card(
          finish,
          { title: 'finish', kind: 'other' },
          { rawInput: FINISH },
          {
            sessionUpdate: 'tool_call_update',
            toolCallId: finish,
            status: 'completed',
            rawOutput: `finished: ${FINISH.summary}`,
          },
        ),
        ...card(
          check,
          { title: 'check', kind: 'execute' },
          { title: CHECK, rawInput: { command: CHECK } },
          {
            sessionUpdate: 'tool_call_update',
            toolCallId: check,
            status: 'completed',
            rawOutput: { ok: true, exit_code: 0, failing_slots: [] },
            content: text_content('```console\nhello\n[exit code 0]\n```'),
          },
        ),
        thought('\n\n**Round 1 verdict: approved**\n\nLooks good.'),
        message('\n\n**Converged** in 1 round. Last verdict: approved.'),
      ]);

      // The edit asked with its diff and an "always" for edits, and landed.
      const [edit_asked, command_asked, check_asked] = permissions.requests;
      expect(permissions.requests).toHaveLength(3);
      expect(edit_asked?.toolCall).toMatchObject({
        toolCallId: write,
        title: 'Write hello.txt',
        content: [{ type: 'diff', path: in_workspace('hello.txt'), oldText: null, newText: 'hello\n' }],
        rawInput: WRITE,
      });
      expect(edit_asked?.options).toEqual([
        ALLOW,
        { optionId: 'allow_always', name: 'Allow all edits this session', kind: 'allow_always' },
        REJECT,
      ]);
      expect(readFileSync(in_workspace('hello.txt'), 'utf8')).toBe('hello\n');

      // The command asked on its card, never ran, and the builder read why.
      expect(command_asked?.toolCall).toMatchObject({ toolCallId: run, title: RUN.command, rawInput: RUN });
      expect(existsSync(in_workspace('ran.txt'))).toBe(false);
      expect(builder_server.seen.map(({ model }) => model)).toEqual(Array(3).fill('vendor/builder-model'));
      expect(builder_server.seen[2]?.messages.at(-1)).toEqual({
        role: 'tool',
        tool_call_id: 'call_run',
        content: JSON.stringify({ error: 'tool_approval_denied' }),
      });

      // The check asked on its own card, offering Allow and Reject alone, and
      // ran once allowed, on the edit that had landed.
      expect(check_asked?.toolCall).toMatchObject({ toolCallId: check, title: CHECK, rawInput: { command: CHECK } });
      expect(check_asked?.options).toEqual([ALLOW, REJECT]);
      expect(existsSync(in_workspace('checked.txt'))).toBe(true);
      expect(on_disk_when_asked).toEqual([[], ['hello.txt'], ['hello.txt']]);

      expect(critic_server.seen.map(({ model }) => model)).toEqual(['vendor/critic-model']);
      expect(existsSync(in_workspace('.volley'))).toBe(false);
      expect(readdirSync(join(state_home, 'volley'))).toHaveLength(1);
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});
