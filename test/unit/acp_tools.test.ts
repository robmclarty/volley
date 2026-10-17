/**
 * The acp seats' tool sets: fascicle's workspace tools for the builder, whose
 * writes and command ask as the session's mode says, plus volley's `finish`;
 * the critic's three reads out of the same set. Both skip volley's
 * `IGNORED_DIRS` and reach `session.cwd` alone, whatever other directories the
 * client sent. Outside a container, with no opt-out, every command asks, and
 * the check asks exactly when a command would; neither sees the seats' keys.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Tool, ToolApprovalRequest } from 'fascicle';
import { workspace_tools } from 'fascicle/acp';
import { acp_command_env, acp_seat_tools } from '../../src/acp_tools.js';
import { SEAT_CREDENTIAL_VARS } from '../../src/engine.js';
import { IGNORED_DIRS } from '../../src/workspace_tools.js';
import { acp_session } from '../helpers/harness.js';

const ctx = {
  abort: new AbortController().signal,
  tool_call_id: 't',
  step_index: 0,
} as const;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp_dir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'volley-acp-tools-'));
  dirs.push(dir);
  return dir;
}

function put(root: string, rel: string, content: string): void {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function by_name(tools: ReadonlyArray<Tool>): Record<string, Tool> {
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

async function call(tool: Tool | undefined, input: unknown): Promise<string> {
  if (tool === undefined) throw new Error('no such tool');
  return String(await tool.execute(input, ctx));
}

async function asks(tool: Tool | undefined, input: unknown): Promise<boolean> {
  const needs = tool?.needs_approval;
  return typeof needs === 'function' ? needs(input) : needs === true;
}

describe('acp_seat_tools: the builder', () => {
  it("is fascicle's six workspace tools plus volley's finish, with no bash or fetch", () => {
    const { builder } = acp_seat_tools(acp_session(temp_dir()));
    expect(builder.tool_set).toBe('acp');
    expect(builder.tools.map((tool) => tool.name)).toEqual([
      'read_file',
      'list_files',
      'search',
      'write_file',
      'edit_file',
      'run_command',
      'finish',
    ]);
  });

  it("writes and runs commands through fascicle's gated tools, which ask as the mode says", async () => {
    const cwd = temp_dir();
    for (const [mode, edit, command] of [
      ['manual', true, true],
      ['accept_edits', false, true],
      ['auto', false, false],
    ] as const) {
      const tools = by_name(acp_seat_tools(acp_session(cwd, [], mode)).builder.tools);
      // Volley's own write_file and edit_file set no needs_approval, so either
      // one in this set would never ask, in any mode.
      expect(await asks(tools.write_file, { path: 'a.txt', content: 'x' })).toBe(edit);
      expect(await asks(tools.edit_file, { path: 'a.txt', old_text: 'x', new_text: 'y' })).toBe(edit);
      expect(await asks(tools.run_command, { command: 'true' })).toBe(command);
      for (const read of ['read_file', 'list_files', 'search']) {
        expect(tools[read]?.needs_approval).toBeUndefined();
      }
    }
  });

  it("ends with volley's terminal finish", async () => {
    const tools = by_name(acp_seat_tools(acp_session(temp_dir())).builder.tools);
    expect(tools.finish?.ends_turn).toBe(true);
    expect(tools.finish?.needs_approval).toBeUndefined();
    expect(await call(tools.finish, { summary: 'wrote the thing' })).toBe('finished: wrote the thing');
  });

  it("runs commands with the agent environment it was given, in place of the process's", async () => {
    const cwd = temp_dir();
    process.env.VOLLEY_ACP_TOOLS_LEAK = 'leaked';
    try {
      const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', VOLLEY_ACP_TOOLS_MARK: 'passed' };
      const tools = by_name(acp_seat_tools(acp_session(cwd), { env }).builder.tools);
      const output = await call(tools.run_command, {
        command: 'echo "$VOLLEY_ACP_TOOLS_MARK ${VOLLEY_ACP_TOOLS_LEAK:-absent}"',
      });
      expect(output).toContain('passed absent');
    } finally {
      delete process.env.VOLLEY_ACP_TOOLS_LEAK;
    }
  });

  it("asks through the session's own approval", () => {
    const session = acp_session(temp_dir());
    expect(acp_seat_tools(session).builder.on_tool_approval).toBe(session.approve);
  });
});

describe('acp_seat_tools: commands outside a container', () => {
  const MODES = ['manual', 'accept_edits', 'auto'] as const;

  it('asks before every command in all three modes, while an edit still asks as the mode says', async () => {
    const cwd = temp_dir();
    for (const mode of MODES) {
      const tools = by_name(
        acp_seat_tools(acp_session(cwd, [], mode), { always_ask_commands: true }).builder.tools,
      );
      expect(await asks(tools.run_command, { command: 'pnpm test' })).toBe(true);
      expect(await asks(tools.write_file, { path: 'a.txt', content: 'x' })).toBe(mode === 'manual');
    }
  });

  it('asks through the session before the check exactly when a builder command would', async () => {
    const cwd = temp_dir();
    const command = 'pnpm exec checkride --json';
    const request: ToolApprovalRequest = {
      tool_name: command,
      input: { command },
      tool_call_id: 'check',
      step_index: 0,
      abort: new AbortController().signal,
    };
    for (const always_ask_commands of [false, true]) {
      for (const mode of MODES) {
        const asked: ToolApprovalRequest[] = [];
        const session = {
          ...acp_session(cwd, [], mode),
          approve: (sent: ToolApprovalRequest) => {
            asked.push(sent);
            return false;
          },
        };
        const { builder, check } = acp_seat_tools(session, { always_ask_commands });
        const expected = always_ask_commands || mode !== 'auto';
        expect(await asks(by_name(builder.tools).run_command, request.input)).toBe(expected);
        // Asked, the session refuses; unasked, the check just runs.
        expect(await check.on_approval?.(request)).toBe(!expected);
        expect(asked).toEqual(expected ? [request] : []);
      }
    }
  });
});

describe('acp_command_env', () => {
  it("is the agent's environment, PATH kept, less every variable a seat reads a key from", () => {
    expect(SEAT_CREDENTIAL_VARS).toEqual(['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY']);
    expect(
      acp_command_env({
        PATH: '/usr/bin:/bin',
        HOME: '/home/someone',
        OPENROUTER_API_KEY: 'sk-or-secret',
        ANTHROPIC_API_KEY: 'sk-ant-secret',
        UNSET: undefined,
      }),
    ).toEqual({ PATH: '/usr/bin:/bin', HOME: '/home/someone' });
  });

  it('keeps both keys from the check and from a command the builder runs, which still finds its programs on PATH', async () => {
    const env = {
      ...process.env,
      OPENROUTER_API_KEY: 'sk-or-secret',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
    };
    const { builder, check } = acp_seat_tools(acp_session(temp_dir()), { env });
    expect(check.env).toEqual(acp_command_env(env));
    // `env` itself is found on PATH, and prints everything the command sees.
    const output = await call(by_name(builder.tools).run_command, { command: 'env' });
    expect(output).toContain(`PATH=${process.env.PATH ?? ''}`);
    expect(output).not.toContain('OPENROUTER_API_KEY');
    expect(output).not.toContain('ANTHROPIC_API_KEY');
    expect(output).not.toContain('secret');
  });
});

describe('acp_seat_tools: the critic', () => {
  it('is exactly the three reads, none of which asks', () => {
    const { critic } = acp_seat_tools(acp_session(temp_dir()));
    expect(critic.tool_set).toBe('acp');
    expect(critic.tools.map((tool) => tool.name)).toEqual(['read_file', 'list_files', 'search']);
    for (const tool of critic.tools) expect(tool.needs_approval).toBeUndefined();
  });
});

describe('acp_seat_tools: what both seats can see', () => {
  it("skips every one of volley's IGNORED_DIRS, which fascicle's default would list", async () => {
    const cwd = temp_dir();
    put(cwd, 'lib/needle.txt', 'needle');
    put(cwd, '.github/needle.txt', 'needle');
    for (const name of IGNORED_DIRS) put(cwd, `${name}/needle.txt`, 'needle');
    const { builder, critic } = acp_seat_tools(acp_session(cwd));
    const fascicle_default = by_name(workspace_tools(acp_session(cwd)));
    for (const tools of [by_name(builder.tools), by_name(critic.tools)]) {
      // A named dot directory lists, so a skipped one is skipped by name.
      expect(await call(tools.list_files, { pattern: '.github/*' })).toBe('.github/needle.txt');
      expect(await call(tools.search, { pattern: 'needle' })).toContain('lib/needle.txt');
      for (const name of IGNORED_DIRS) {
        expect(await call(tools.list_files, { pattern: `${name}/*` })).toMatch(/^no files match/);
        expect(await call(tools.search, { pattern: 'needle', glob: `${name}/*` })).not.toContain(
          `${name}/needle.txt`,
        );
      }
    }
    // fascicle's own default skips only .git and node_modules.
    expect(await call(fascicle_default.list_files, { pattern: 'dist/*' })).toBe('dist/needle.txt');
  });

  it("refuses a path under one of the session's additional directories", async () => {
    const cwd = temp_dir();
    const extra = temp_dir();
    put(cwd, 'inside.txt', 'inside');
    put(extra, 'outside.txt', 'outside');
    const session = acp_session(cwd, [extra]);
    const outside = join(extra, 'outside.txt');
    // The session itself reaches the extra directory; the seats' copy doesn't.
    expect(await call(by_name(workspace_tools(session)).read_file, { path: outside })).toContain(
      'outside',
    );
    const { builder, critic } = acp_seat_tools(session);
    for (const tools of [by_name(builder.tools), by_name(critic.tools)]) {
      expect(await call(tools.read_file, { path: 'inside.txt' })).toContain('inside');
      await expect(call(tools.read_file, { path: outside })).rejects.toThrow(/outside the workspace/);
      await expect(call(tools.list_files, { path: extra })).rejects.toThrow(/outside the workspace/);
      await expect(call(tools.search, { pattern: 'outside', path: extra })).rejects.toThrow(
        /outside the workspace/,
      );
    }
    const writes = by_name(builder.tools);
    const written = join(extra, 'written.txt');
    await expect(call(writes.write_file, { path: written, content: 'x' })).rejects.toThrow(
      /outside the workspace/,
    );
    await expect(
      call(writes.edit_file, { path: outside, old_text: 'outside', new_text: 'moved' }),
    ).rejects.toThrow(/outside the workspace/);
    expect(existsSync(written)).toBe(false);
    // The copy leaves the session the client opened as it was.
    expect(session.roots).toHaveLength(2);
  });
});
