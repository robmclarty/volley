import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Tool } from 'fascicle';
import {
  READ_FILE_MAX_BYTES,
  SEARCH_MAX_MATCHES,
  contain,
  read_only_tools,
} from '../../src/critic/tools.js';
import { temp_workspace } from '../helpers/harness.js';

const ctx = {
  abort: new AbortController().signal,
  tool_call_id: 't',
  step_index: 0,
} as const;

function tool_map(workspace: string): Record<string, Tool> {
  return Object.fromEntries(read_only_tools(workspace).map((t) => [t.name, t]));
}

async function call(tool: Tool, input: unknown): Promise<string> {
  return (await tool.execute(input, ctx)) as string;
}

function seed(workspace: string): void {
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'src', 'a.ts'), 'export const answer = 42;\nconst secret = "x";\n');
  writeFileSync(join(workspace, 'src', 'b.ts'), 'export const other = 1;\n');
  writeFileSync(join(workspace, 'README.md'), '# hello\nthe answer is 42\n');
  mkdirSync(join(workspace, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(workspace, 'node_modules', 'pkg', 'index.js'), 'the answer is here too\n');
}

describe('contain', () => {
  it('resolves workspace-relative paths', () => {
    expect(contain('/ws', 'src/a.ts')).toBe('/ws/src/a.ts');
    expect(contain('/ws', '.')).toBe('/ws');
  });

  it('rejects traversal and absolute escapes', () => {
    expect(() => contain('/ws', '../etc/passwd')).toThrow(/escapes the workspace/);
    expect(() => contain('/ws', '/etc/passwd')).toThrow(/escapes the workspace/);
    expect(() => contain('/ws', 'src/../../oops')).toThrow(/escapes the workspace/);
  });
});

describe('read_file', () => {
  it('reads a workspace file', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      seed(workspace);
      const tools = tool_map(workspace);
      expect(await call(tools.read_file!, { path: 'src/a.ts' })).toContain('answer = 42');
    } finally {
      cleanup();
    }
  });

  it('refuses to read outside the workspace', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = tool_map(workspace);
      await expect(call(tools.read_file!, { path: '../../etc/hosts' })).rejects.toThrow(
        /escapes the workspace/,
      );
    } finally {
      cleanup();
    }
  });

  it('truncates oversized files', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      writeFileSync(join(workspace, 'big.txt'), 'z'.repeat(READ_FILE_MAX_BYTES + 500));
      const tools = tool_map(workspace);
      const out = await call(tools.read_file!, { path: 'big.txt' });
      expect(out).toContain('truncated');
    } finally {
      cleanup();
    }
  });

  it('rejects malformed arguments via the schema', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = tool_map(workspace);
      await expect(call(tools.read_file!, { wrong: 1 })).rejects.toThrow();
    } finally {
      cleanup();
    }
  });
});

describe('search_files', () => {
  it('finds matching lines and skips ignored directories', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      seed(workspace);
      const tools = tool_map(workspace);
      const out = await call(tools.search_files!, { pattern: 'answer' });
      expect(out).toContain('src/a.ts:1:');
      expect(out).toContain('README.md:2:');
      // node_modules is never searched.
      expect(out).not.toContain('node_modules');
    } finally {
      cleanup();
    }
  });

  it('honors a path scope and case-insensitivity', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      seed(workspace);
      const tools = tool_map(workspace);
      const out = await call(tools.search_files!, { pattern: 'ANSWER', path: 'src', ignore_case: true });
      expect(out).toContain('src/a.ts');
      expect(out).not.toContain('README.md');
    } finally {
      cleanup();
    }
  });

  it('reports no matches cleanly and rejects bad regex', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      seed(workspace);
      const tools = tool_map(workspace);
      expect(await call(tools.search_files!, { pattern: 'zzznotfound' })).toBe('no matches');
      await expect(call(tools.search_files!, { pattern: '(' })).rejects.toThrow(
        /invalid regular expression/,
      );
    } finally {
      cleanup();
    }
  });
});

describe('list_files', () => {
  it('lists workspace files, skipping ignored dirs, with an optional filter', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      seed(workspace);
      const tools = tool_map(workspace);
      const all = await call(tools.list_files!, {});
      expect(all).toContain('src/a.ts');
      expect(all).toContain('README.md');
      expect(all).not.toContain('node_modules');

      const filtered = await call(tools.list_files!, { contains: '.ts' });
      expect(filtered).toContain('src/a.ts');
      expect(filtered).not.toContain('README.md');
    } finally {
      cleanup();
    }
  });
});

describe('read_only_tools', () => {
  it('exposes exactly the three read-only tools', () => {
    expect(read_only_tools('/ws').map((t) => t.name)).toEqual([
      'read_file',
      'search_files',
      'list_files',
    ]);
  });

  it('caps the match count constant sanely', () => {
    expect(SEARCH_MAX_MATCHES).toBeGreaterThan(0);
  });
});
