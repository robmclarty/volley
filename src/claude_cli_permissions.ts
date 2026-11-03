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
