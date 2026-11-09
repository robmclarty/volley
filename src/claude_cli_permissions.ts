/**
 * What a `claude_cli` seat may touch. The CLI runs in the build root (its
 * session cwd), and two layers keep its file tools there:
 *
 * - The allowlist names only path rules the CLI matches. It checks file
 *   permissions against `Edit(path)` and `Read(path)` alone (an `Edit` rule
 *   governs the Write tool too; a `Write(path)` or `MultiEdit(path)` rule is
 *   accepted and never matched), and a bare `Write` or `Read` approves every
 *   path on the machine. `/` anchors a rule at the session's working
 *   directory. Reads, searches, and globs inside the working directory need no
 *   rule at all, so `Grep` and `Glob` aren't listed: a bare entry for either
 *   would only reach outside it.
 * - `--settings` turns on the CLI's own blocks, which refuse file tools outside
 *   the working directories in every permission mode, `bypassPermissions`
 *   included, where allow rules decide nothing. The write block needs Claude
 *   Code 2.1.314, the read block 2.1.257; an older CLI ignores the key, which
 *   the dry run warns about.
 *
 * `Bash` stays unconfined: the blocks cover file tools only.
 */
import type { ResolvedConfig } from './types.js';

/** Whether a seat this run drives runs on the Claude CLI. A critique has no
 * builder, whatever its provider resolved to. */
export function uses_claude_cli(config: ResolvedConfig): boolean {
  return (
    (config.mode !== 'critique' && config.builder_provider === 'claude_cli') ||
    config.critic_provider === 'claude_cli'
  );
}

export const BUILDER_ALLOWED_TOOLS = ['Read(/**)', 'Edit(/**)', 'Bash', 'WebFetch'] as const;

export const CRITIC_ALLOWED_TOOLS = ['Read(/**)'] as const;

export const CRITIC_DISALLOWED_TOOLS = 'Write,Edit,MultiEdit,NotebookEdit,Bash';

/** A gate pattern an `Edit(...)` rule can carry: one with no space, comma or
 * parenthesis, which the CLI would read as the rule list's own syntax. One
 * that can't be carried is left out, so the tester can write less, never
 * more. */
function rule_safe(pattern: string): boolean {
  return !/[\s,()]/.test(pattern);
}

/** A `claude_cli` tester's allowlist (move 1's D19): reads anywhere in the
 * build root, and one `Edit` rule per writable gate pattern
 * (`writable_gate_patterns`), anchored at the build root. The tester runs in
 * the CLI's default permission mode, where an edit no rule allows is refused,
 * since `-p` has no one to ask. */
export function tester_allowed_tools(writable: ReadonlyArray<string>): string[] {
  return [
    'Read(/**)',
    ...writable.filter(rule_safe).map((pattern) => `Edit(/${pattern.replace(/^\/+/, '')})`),
  ];
}

/** What a `claude_cli` tester is refused outright: a shell and notebooks, and
 * an edit to the files the gate patterns cover that configure the check rather
 * than test the work (D20). A deny rule wins over the allowlist in every
 * permission mode. */
export const TESTER_DISALLOWED_TOOLS = [
  'Bash',
  'NotebookEdit',
  'Edit(/**/package.json)',
  'Edit(/**/*.config.*)',
  'Edit(/**/.github/**)',
].join(',');

const PERMISSION_BLOCKS = {
  permissions: {
    blockWritesOutsideWorkingDirectories: true,
    blockReadsOutsideWorkingDirectories: true,
  },
} as const;

/** The CLI flags that turn on `PERMISSION_BLOCKS`. */
export function settings_args(): string[] {
  return ['--settings', JSON.stringify(PERMISSION_BLOCKS)];
}

export type ClaudeVersion = readonly [number, number, number];

export const MIN_CLAUDE_WRITE_BLOCK: ClaudeVersion = [2, 1, 314];

export const MIN_CLAUDE_READ_BLOCK: ClaudeVersion = [2, 1, 257];

/** The version `claude --version` printed (`2.1.316 (Claude Code)`), or null
 * when it printed something else. */
export function parse_claude_version(stdout: string): ClaudeVersion | null {
  const match = /^\s*(\d+)\.(\d+)\.(\d+)\b/.exec(stdout);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function version_below(version: ClaudeVersion, min: ClaudeVersion): boolean {
  const [major, minor, patch] = version;
  const [min_major, min_minor, min_patch] = min;
  if (major !== min_major) return major < min_major;
  if (minor !== min_minor) return minor < min_minor;
  return patch < min_patch;
}

export function format_version(version: ClaudeVersion): string {
  return version.join('.');
}
