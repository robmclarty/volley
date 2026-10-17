/**
 * The seats' tool sets under `volley acp`.
 *
 * Volley's own `write_file`, `edit_file`, and `bash` set no `needs_approval`,
 * so served to an editor they would edit and run commands unasked in every
 * mode. Under acp the builder gets fascicle's workspace tools instead, whose
 * writes and `run_command` ask as the session's mode says, plus volley's
 * `finish`; the critic gets that set's three reads, which never ask. Neither
 * gets `fetch`, which would reach the network unasked.
 *
 * Both sets see the session through a copy whose only root is `session.cwd`.
 * The check, the change list, and the critic all look there alone, so an edit
 * in one of the client's additional directories would never be checked or
 * reviewed. And both skip volley's `IGNORED_DIRS` rather than fascicle's
 * shorter default, so a seat sees the same tree under acp as on the CLI.
 */
import { workspace_tools } from 'fascicle/acp';
import type { AcpSession } from 'fascicle/acp';
import type { Tool } from 'fascicle';
import { finish_tool } from './builder/tools.js';
import { IGNORED_DIRS } from './workspace_tools.js';
import type { ToolSet } from './workspace_tools.js';

/** The reads the critic takes from the session's set. */
const CRITIC_READS: ReadonlySet<string> = new Set(['read_file', 'list_files', 'search']);

type AcpToolOptions = {
  /** The whole environment the builder's commands run with, in place of the
   * agent's own; nothing is merged in, so it carries the `PATH` they need. */
  command_env?: Readonly<Record<string, string>>;
};

/** One seat's tools, with the name of their set, which its prompt names. */
type AcpSeatTools = { tools: ReadonlyArray<Tool>; tool_set: ToolSet };

/** `session` with `cwd` as its only root. `roots` holds `cwd`'s real path
 * first, and that is what the file tools check a path against. */
function cwd_only(session: AcpSession): AcpSession {
  return { ...session, additional_directories: [], roots: session.roots.slice(0, 1) };
}

/** Both seats' tools for one session: the builder's six workspace tools plus
 * `finish`, and the critic's three reads out of the same set. */
export function acp_seat_tools(
  session: AcpSession,
  options: AcpToolOptions = {},
): { builder: AcpSeatTools; critic: AcpSeatTools } {
  const tools = workspace_tools(cwd_only(session), {
    ignore: [...IGNORED_DIRS],
    command_env: options.command_env,
  });
  return {
    builder: { tools: [...tools, finish_tool()], tool_set: 'acp' },
    critic: { tools: tools.filter((tool) => CRITIC_READS.has(tool.name)), tool_set: 'acp' },
  };
}
