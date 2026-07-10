import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Tool } from 'fascicle';
import { WRITE_FILE_MAX_BYTES, builder_tools } from '../../src/builder/tools.js';
import { temp_workspace } from '../helpers/harness.js';

const ctx = {
  abort: new AbortController().signal,
  tool_call_id: 't',
  step_index: 0,
} as const;

function tool_map(workspace: string): Record<string, Tool> {
  return Object.fromEntries(builder_tools(workspace).map((t) => [t.name, t]));
}

async function call(tool: Tool, input: unknown): Promise<string> {
  return (await tool.execute(input, ctx)) as string;
}

type BashResult = { exit_code: number | null; stdout: string; stderr: string };

async function call_bash(tool: Tool, command: string): Promise<BashResult> {
  return (await tool.execute({ command }, ctx)) as BashResult;
}

describe('builder_tools', () => {
  it('exposes the read trio plus write_file, edit_file, bash, and finish', () => {
    expect(builder_tools('/ws').map((t) => t.name)).toEqual([
      'read_file',
      'search_files',
      'list_files',
      'write_file',
      'edit_file',
      'bash',
      'finish',
    ]);
  });
});

describe('write_file', () => {
  it('writes a file, creating parent directories, and overwrites', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = tool_map(workspace);
      const out = await call(tools.write_file!, { path: 'deep/nested/a.ts', content: 'one' });
      expect(out).toContain('deep/nested/a.ts');
      expect(readFileSync(join(workspace, 'deep', 'nested', 'a.ts'), 'utf8')).toBe('one');

      await call(tools.write_file!, { path: 'deep/nested/a.ts', content: 'two' });
      expect(readFileSync(join(workspace, 'deep', 'nested', 'a.ts'), 'utf8')).toBe('two');
    } finally {
      cleanup();
    }
  });

  it('throws on content over the write cap', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = tool_map(workspace);
      await expect(
        call(tools.write_file!, { path: 'big.txt', content: 'z'.repeat(WRITE_FILE_MAX_BYTES + 1) }),
      ).rejects.toThrow(/write cap/);
    } finally {
      cleanup();
    }
  });

  it('refuses to write outside the workspace', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = tool_map(workspace);
      await expect(call(tools.write_file!, { path: '../evil.txt', content: 'x' })).rejects.toThrow(
        /escapes the workspace/,
      );
    } finally {
      cleanup();
    }
  });
});

describe('edit_file', () => {
  function seed(workspace: string): void {
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, 'src', 'a.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    writeFileSync(join(workspace, 'src', 'dup.ts'), 'same\nsame\nsame\n');
  }

  it('replaces a unique exact match', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      seed(workspace);
      const tools = tool_map(workspace);
      const out = await call(tools.edit_file!, {
        path: 'src/a.ts',
        old_str: 'const b = 2;',
        new_str: 'const b = 20;',
      });
      expect(out).toContain('edit applied');
      expect(readFileSync(join(workspace, 'src', 'a.ts'), 'utf8')).toBe(
        'const a = 1;\nconst b = 20;\nconst c = 3;\n',
      );
    } finally {
      cleanup();
    }
  });

  it('returns (not throws) an error on 0 matches and changes nothing', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      seed(workspace);
      const tools = tool_map(workspace);
      const out = await call(tools.edit_file!, {
        path: 'src/a.ts',
        old_str: 'const z = 9;',
        new_str: 'const z = 10;',
      });
      expect(out).toContain('0 matches');
      expect(out).toContain('No change made');
      expect(readFileSync(join(workspace, 'src', 'a.ts'), 'utf8')).toContain('const b = 2;');
    } finally {
      cleanup();
    }
  });

  it('returns (not throws) an error on multiple matches and changes nothing', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      seed(workspace);
      const tools = tool_map(workspace);
      const out = await call(tools.edit_file!, {
        path: 'src/dup.ts',
        old_str: 'same',
        new_str: 'different',
      });
      expect(out).toContain('matches 3 times');
      expect(out).toContain('No change made');
      expect(readFileSync(join(workspace, 'src', 'dup.ts'), 'utf8')).toBe('same\nsame\nsame\n');
    } finally {
      cleanup();
    }
  });

  it('refuses to edit outside the workspace', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = tool_map(workspace);
      await expect(
        call(tools.edit_file!, { path: '../../etc/hosts', old_str: 'a', new_str: 'b' }),
      ).rejects.toThrow(/escapes the workspace/);
    } finally {
      cleanup();
    }
  });
});

describe('bash', () => {
  it('returns stdout and exit_code 0 for a zero-exit command', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = tool_map(workspace);
      const out = await call_bash(tools.bash!, 'echo hello');
      expect(out.exit_code).toBe(0);
      expect(out.stdout).toContain('hello');
      expect(out.stderr).toBe('');
    } finally {
      cleanup();
    }
  });

  it('runs in the workspace directory (stateless per command)', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = tool_map(workspace);
      await call(tools.write_file!, { path: 'marker.txt', content: 'in-workspace' });
      const out = await call_bash(tools.bash!, 'cat marker.txt');
      expect(out.exit_code).toBe(0);
      expect(out.stdout).toContain('in-workspace');
    } finally {
      cleanup();
    }
  });

  it('returns (not throws) a non-zero exit with stdout and stderr', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = tool_map(workspace);
      const out = await call_bash(tools.bash!, 'echo out; echo err >&2; exit 7');
      expect(out.exit_code).toBe(7);
      expect(out.stdout).toContain('out');
      expect(out.stderr).toContain('err');
    } finally {
      cleanup();
    }
  });

  it('truncates output past the byte cap with a marker', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = builder_tools(workspace, { bash_max_output_bytes: 20 });
      const bash = tools.find((t) => t.name === 'bash')!;
      const out = await call_bash(bash, 'printf "%s" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
      expect(out.exit_code).toBe(0);
      expect(out.stdout).toContain('[truncated at 20 bytes]');
      // 20 kept bytes + a newline + the marker line
      expect(out.stdout.startsWith('aaaaaaaaaaaaaaaaaaaa\n…')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('returns a timed-out command as a normal result, not an error', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = builder_tools(workspace, { bash_timeout_ms: 100 });
      const bash = tools.find((t) => t.name === 'bash')!;
      const out = await call_bash(bash, 'sleep 5');
      expect(out.exit_code).toBeNull();
      expect(out.stderr).toContain('timed out');
    } finally {
      cleanup();
    }
  });
});

describe('finish', () => {
  it('is declared terminal (ends_turn) and returns cleanly', async () => {
    const tools = tool_map('/ws');
    expect(tools.finish!.ends_turn).toBe(true);
    expect(await call(tools.finish!, { summary: 'wrote the thing' })).toContain('wrote the thing');
  });
});
