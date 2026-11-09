import { describe, expect, it } from 'vitest';
import {
  BUILDER_ALLOWED_TOOLS,
  CRITIC_ALLOWED_TOOLS,
  CRITIC_DISALLOWED_TOOLS,
  MIN_CLAUDE_READ_BLOCK,
  MIN_CLAUDE_WRITE_BLOCK,
  parse_claude_version,
  settings_args,
  tester_allowed_tools,
  TESTER_DISALLOWED_TOOLS,
  version_below,
} from '../../src/claude_cli_permissions.js';
import { DEFAULT_GATE_PATTERNS } from '../../src/changes.js';
import { writable_gate_patterns } from '../../src/tester/tools.js';

describe('claude_cli seat permissions', () => {
  it("scopes the builder's file tools to the build root, and lists no bare file tool", () => {
    expect(BUILDER_ALLOWED_TOOLS).toEqual(['Read(/**)', 'Edit(/**)', 'Bash', 'WebFetch']);
  });

  it('gives the critic scoped reads and disallows every write and Bash', () => {
    expect(CRITIC_ALLOWED_TOOLS).toEqual(['Read(/**)']);
    expect(CRITIC_DISALLOWED_TOOLS).toBe('Write,Edit,MultiEdit,NotebookEdit,Bash');
  });

  it("gives the tester scoped reads and one Edit rule per writable gate pattern, and no Bash", () => {
    expect(tester_allowed_tools(writable_gate_patterns(DEFAULT_GATE_PATTERNS))).toEqual([
      'Read(/**)',
      'Edit(/**/*.test.*)',
      'Edit(/**/*.spec.*)',
      'Edit(/**/*_test.*)',
      'Edit(/**/test/**)',
      'Edit(/**/tests/**)',
      'Edit(/**/__tests__/**)',
      'Edit(/**/spec/**)',
      'Edit(/**/fixtures/**)',
    ]);
    const disallowed = TESTER_DISALLOWED_TOOLS.split(',');
    expect(disallowed).toContain('Bash');
    expect(disallowed).toContain('NotebookEdit');
    // The files a test pattern can reach that configure the check (D20).
    expect(disallowed).toEqual(
      expect.arrayContaining(['Edit(/**/package.json)', 'Edit(/**/*.config.*)', 'Edit(/**/.github/**)']),
    );
  });

  it("leaves out a tester pattern a rule can't carry, so the tester writes less, not more", () => {
    expect(tester_allowed_tools(['test/**', 'odd dir/**', 'a,b/**', 'x(y)/**', '/spec/**'])).toEqual([
      'Read(/**)',
      'Edit(/test/**)',
      'Edit(/spec/**)',
    ]);
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
