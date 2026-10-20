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
 * Both sets are built from the session itself, since fascicle keys a
 * session's cards and prompts on it: a copy would lose each edit's diff, each
 * command's terminal, and the "always" a prompt offers. The session holds
 * `session.cwd` alone, because volley serves no additional directories
 * (`./acp.ts`), and both sets skip volley's `IGNORED_DIRS` rather than
 * fascicle's shorter default, so a seat sees the same tree under acp as on the
 * CLI.
 *
 * The builder's commands and the check run with the agent's environment less
 * every key a seat reads, so nothing the builder writes can read them. The
 * check asks, through the session, exactly when `run_command`'s own gate would
 * ask before the same command; outside a container, with no opt-out, Auto
 * isn't offered, so that gate asks in every mode the user can pick.
 */
import { workspace_tools } from 'fascicle/acp';
import type { AcpSession } from 'fascicle/acp';
import type { Tool, ToolApprovalHandler } from 'fascicle';
import { finish_tool } from './builder/tools.js';
import { SEAT_CREDENTIAL_VARS } from './engine.js';
import type { CheckGate } from './phases.js';
import { IGNORED_DIRS } from './workspace_tools.js';
import type { ToolSet } from './workspace_tools.js';

/** The reads the critic takes from the session's set. */
const CRITIC_READS: ReadonlySet<string> = new Set(['read_file', 'list_files', 'search']);

type Env = Readonly<Record<string, string | undefined>>;

type AcpToolOptions = {
  /** The agent's environment, which the builder's commands and the check run
   * with, less the seats' keys; default: the process's. */
  env?: Env;
};

/** One seat's tools, with the name of their set, which its prompt names. */
type AcpSeatTools = { tools: ReadonlyArray<Tool>; tool_set: ToolSet };

/** The environment the builder's commands and the check run with under acp:
 * the agent's own, `PATH` included, less every variable a seat reads a
 * credential from. */
export function acp_command_env(env: Env): Record<string, string> {
  const stripped: ReadonlySet<string> = new Set(SEAT_CREDENTIAL_VARS);
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !stripped.has(entry[0]),
    ),
  );
}

/** Whether `tool` asks before a call with `input`. A set without the tool
 * asks, so a check never runs unasked by mistake. */
async function asks_before(tool: Tool | undefined, input: unknown): Promise<boolean> {
  if (tool === undefined) return true;
  const needs = tool.needs_approval;
  return typeof needs === 'function' ? needs(input) : needs === true;
}

/** What one session gives the seats and the check: the builder's six
 * workspace tools plus `finish`, asking through `session.approve`; the
 * critic's three reads out of the same set; and the check's environment,
 * the same as the builder's commands get, with an approval that asks through
 * the session exactly when the builder's `run_command` would ask before
 * running the same command. */
export function acp_seat_tools(
  session: AcpSession,
  options: AcpToolOptions = {},
): {
  builder: AcpSeatTools & { on_tool_approval: ToolApprovalHandler };
  critic: AcpSeatTools;
  check: CheckGate;
} {
  const command_env = acp_command_env(options.env ?? process.env);
  const tools = workspace_tools(session, { ignore: [...IGNORED_DIRS], command_env });
  const run_command = tools.find((tool) => tool.name === 'run_command');
  return {
    builder: {
      tools: [...tools, finish_tool()],
      tool_set: 'acp',
      on_tool_approval: session.approve,
    },
    critic: { tools: tools.filter((tool) => CRITIC_READS.has(tool.name)), tool_set: 'acp' },
    check: {
      env: command_env,
      on_approval: async (request) =>
        (await asks_before(run_command, request.input)) ? session.approve(request) : true,
    },
  };
}
