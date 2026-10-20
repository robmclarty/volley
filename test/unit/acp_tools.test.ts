/**
 * The acp seats' tool sets: fascicle's workspace tools for the builder, whose
 * writes and command ask as the session's mode says, plus volley's `finish`;
 * the critic's three reads out of the same set. Both skip volley's
 * `IGNORED_DIRS`. The check asks exactly when `run_command`'s own gate would,
 * and neither it nor a command sees the seats' keys.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe('acp_seat_tools: the check', () => {
  it("asks through the session exactly when run_command's own gate would ask before the same command", async () => {
    const cwd = temp_dir();
    const command = 'pnpm exec checkride --json';
    const request: ToolApprovalRequest = {
      tool_name: command,
      input: { command },
      tool_call_id: 'check',
      step_index: 0,
      abort: new AbortController().signal,
    };
    for (const mode of ['manual', 'accept_edits', 'auto'] as const) {
      const asked: ToolApprovalRequest[] = [];
      const session = {
        ...acp_session(cwd, [], mode),
        approve: (sent: ToolApprovalRequest) => {
          asked.push(sent);
          return false;
        },
      };
      const { builder, check } = acp_seat_tools(session);
      const expected = mode !== 'auto';
      expect(await asks(by_name(builder.tools).run_command, request.input)).toBe(expected);
      // Asked, the session refuses; unasked, the check just runs.
      expect(await check.on_approval?.(request)).toBe(!expected);
      expect(asked).toEqual(expected ? [request] : []);
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
});
