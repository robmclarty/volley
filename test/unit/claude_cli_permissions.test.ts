import { describe, expect, it } from 'vitest';
import {
  BUILDER_ALLOWED_TOOLS,
  CRITIC_ALLOWED_TOOLS,
  CRITIC_DISALLOWED_TOOLS,
  MIN_CLAUDE_READ_BLOCK,
  MIN_CLAUDE_WRITE_BLOCK,
  parse_claude_version,
  settings_args,
  version_below,
} from '../../src/claude_cli_permissions.js';

describe('claude_cli seat permissions', () => {
  it("scopes the builder's file tools to the build root, and lists no bare file tool", () => {
    expect(BUILDER_ALLOWED_TOOLS).toEqual(['Read(/**)', 'Edit(/**)', 'Bash', 'WebFetch']);
  });

  it('gives the critic scoped reads and disallows every write and Bash', () => {
    expect(CRITIC_ALLOWED_TOOLS).toEqual(['Read(/**)']);
    expect(CRITIC_DISALLOWED_TOOLS).toBe('Write,Edit,MultiEdit,NotebookEdit,Bash');
  });

  it('turns on both blocks through --settings', () => {
    expect(settings_args()).toEqual([
      '--settings',
      '{"permissions":{"blockWritesOutsideWorkingDirectories":true,"blockReadsOutsideWorkingDirectories":true}}',
    ]);
  });
});

describe('parse_claude_version', () => {
  it('reads what claude --version prints', () => {
    expect(parse_claude_version('2.1.316 (Claude Code)\n')).toEqual([2, 1, 316]);
  });

  it('is null for anything else', () => {
    expect(parse_claude_version('')).toBeNull();
    expect(parse_claude_version('claude: command not found')).toBeNull();
    expect(parse_claude_version('2.1 (Claude Code)')).toBeNull();
  });
});

describe('version_below', () => {
  it('compares major, then minor, then patch', () => {
    expect(version_below([2, 1, 313], MIN_CLAUDE_WRITE_BLOCK)).toBe(true);
    expect(version_below([2, 1, 314], MIN_CLAUDE_WRITE_BLOCK)).toBe(false);
    expect(version_below([2, 2, 0], MIN_CLAUDE_WRITE_BLOCK)).toBe(false);
    expect(version_below([1, 9, 999], MIN_CLAUDE_READ_BLOCK)).toBe(true);
    expect(version_below([3, 0, 0], MIN_CLAUDE_READ_BLOCK)).toBe(false);
  });
});
