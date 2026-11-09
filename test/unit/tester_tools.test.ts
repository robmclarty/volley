import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Tool } from 'fascicle';
import { DEFAULT_GATE_PATTERNS } from '../../src/changes.js';
import { tester_tools, writable_gate_patterns } from '../../src/tester/tools.js';
import { temp_workspace } from '../helpers/harness.js';

const ctx = {
  abort: new AbortController().signal,
  tool_call_id: 't',
  step_index: 0,
} as const;

function tool_map(workspace: string, gate_paths = DEFAULT_GATE_PATTERNS): Record<string, Tool> {
  return Object.fromEntries(tester_tools(workspace, gate_paths).map((t) => [t.name, t]));
}

async function call(tool: Tool | undefined, input: unknown): Promise<unknown> {
  if (tool === undefined) throw new Error('no such tool');
  return tool.execute(input, ctx);
}

describe('tester_tools', () => {
  it('exposes the read trio plus write_file and edit_file, and no bash', () => {
    expect(tester_tools('/ws', DEFAULT_GATE_PATTERNS).map((t) => t.name)).toEqual([
      'read_file',
      'search_files',
      'list_files',
      'write_file',
      'edit_file',
    ]);
  });

  it('writes a test and a fixture, and edits a test', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = tool_map(workspace);
      await call(tools['write_file'], { path: 'src/ledger.test.ts', content: 'it fails\n' });
      await call(tools['write_file'], { path: 'test/fixtures/books.txt', content: 'cash 10\n' });
      await call(tools['edit_file'], {
        path: 'src/ledger.test.ts',
        old_str: 'fails',
        new_str: 'still fails',
      });
      expect(readFileSync(join(workspace, 'src/ledger.test.ts'), 'utf8')).toBe('it still fails\n');
      expect(existsSync(join(workspace, 'test/fixtures/books.txt'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('refuses a write outside the test and fixture paths, naming the path', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = tool_map(workspace);
      await expect(
        call(tools['write_file'], { path: 'src/ledger.ts', content: 'export {}' }),
      ).rejects.toThrow(/can't write src\/ledger\.ts: it matches none of the test and fixture gate patterns/);
      expect(existsSync(join(workspace, 'src/ledger.ts'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('refuses package.json, at the root and under a test directory, naming the path', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      writeFileSync(join(workspace, 'package.json'), '{}\n');
      const tools = tool_map(workspace);
      await expect(
        call(tools['write_file'], { path: 'package.json', content: '{"scripts":{}}' }),
      ).rejects.toThrow(/can't write package\.json: package\.json decides which scripts and tests run/);
      await expect(
        call(tools['edit_file'], { path: 'package.json', old_str: '{}', new_str: '{"a":1}' }),
      ).rejects.toThrow(/can't write package\.json/);
      await expect(
        call(tools['write_file'], { path: 'test/package.json', content: '{}' }),
      ).rejects.toThrow(/can't write test\/package\.json/);
      expect(readFileSync(join(workspace, 'package.json'), 'utf8')).toBe('{}\n');
    } finally {
      cleanup();
    }
  });

  it('refuses check config and CI, even where a test pattern matches', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = tool_map(workspace);
      for (const path of ['vitest.config.ts', 'test/checkride.config.json', '.github/workflows/ci.yml']) {
        await expect(call(tools['write_file'], { path, content: 'x' })).rejects.toThrow(
          `can't write ${path}`,
        );
        expect(existsSync(join(workspace, path))).toBe(false);
      }
      // A config file inside a test directory still configures the check.
      await expect(
        call(tools['write_file'], { path: 'test/vitest.config.mjs', content: 'x' }),
      ).rejects.toThrow(/a \*\.config\.\* file configures the check/);
    } finally {
      cleanup();
    }
  });

  it('refuses an escape from the workspace', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = tool_map(workspace);
      await expect(
        call(tools['write_file'], { path: '../outside.test.ts', content: 'x' }),
      ).rejects.toThrow(/escapes the workspace/);
    } finally {
      cleanup();
    }
  });

  it('refuses a write that reaches through a symbolic link into the source', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      mkdirSync(join(workspace, 'src'));
      symlinkSync(join(workspace, 'src'), join(workspace, 'test'));
      const tools = tool_map(workspace);
      await expect(
        call(tools['write_file'], { path: 'test/ledger.ts', content: 'export {}' }),
      ).rejects.toThrow(/can't write test\/ledger\.ts: it reaches through a symbolic link/);
      expect(existsSync(join(workspace, 'src/ledger.ts'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('writes nothing when the gate names no test or fixture path', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = tool_map(workspace, ['**/package.json']);
      await expect(
        call(tools['write_file'], { path: 'a.test.ts', content: 'x' }),
      ).rejects.toThrow(/no gate pattern names a test or fixture path/);
    } finally {
      cleanup();
    }
  });
});

describe('writable_gate_patterns', () => {
  it('keeps the default tests and fixtures, and drops the manifest, check config and CI', () => {
    expect(writable_gate_patterns(DEFAULT_GATE_PATTERNS)).toEqual([
      '**/*.test.*',
      '**/*.spec.*',
      '**/*_test.*',
      '**/test/**',
      '**/tests/**',
      '**/__tests__/**',
      '**/spec/**',
      '**/fixtures/**',
    ]);
  });
});
