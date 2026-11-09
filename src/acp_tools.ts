/**
 * The seats' tool sets under `volley acp`.
 *
 * Volley's own `write_file`, `edit_file`, and `bash` set no `needs_approval`,
 * so served to an editor they would edit and run commands unasked in every
 * mode. Under acp the builder gets fascicle's workspace tools instead, whose
 * writes and `run_command` ask as the session's mode says, plus volley's
 * `finish`; the critic gets that set's three reads, which never ask. Neither
 * gets `fetch`, which would reach the network unasked. The tester gets the
 * three reads and the two writes, which ask as the builder's do, held to the
 * test and fixture gate paths: a path the tester may not write is refused
 * before anyone is asked about it (move 1's D20).
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
import { command_env } from './engine.js';
import type { CheckGate } from './phases.js';
import { tester_refusal } from './tester/tools.js';
import { IGNORED_DIRS } from './workspace_tools.js';
import type { ToolSet } from './workspace_tools.js';

/** The reads the critic takes from the session's set. */
const CRITIC_READS: ReadonlySet<string> = new Set(['read_file', 'list_files', 'search']);

/** The writes the tester takes beside those reads. */
const TESTER_WRITES: ReadonlySet<string> = new Set(['write_file', 'edit_file']);

type Env = Readonly<Record<string, string | undefined>>;

type AcpToolOptions = {
  /** The agent's environment, which the builder's commands and the check run
   * with, less the seats' keys; default: the process's. */
  env?: Env;
  /** The gate patterns the tester's writes are held to; default: none, so a
   * tester writes nothing. */
  gate_paths?: ReadonlyArray<string>;
};

/** One seat's tools, with the name of their set, which its prompt names. */
type AcpSeatTools = { tools: ReadonlyArray<Tool>; tool_set: ToolSet };

/** Whether `tool` asks before a call with `input`. A set without the tool
 * asks, so a check never runs unasked by mistake. */
async function asks_before(tool: Tool | undefined, input: unknown): Promise<boolean> {
  if (tool === undefined) return true;
  const needs = tool.needs_approval;
  return typeof needs === 'function' ? needs(input) : needs === true;
}

/** `tool`, refusing a call whose path `refusal` names a reason for, before
 * it asks: a write the tester may not make is never put to the person, and
 * its error names why, as volley's own writers' does. Every other call asks
 * as `tool` would, and runs as it would. */
function confined(tool: Tool, refusal: (input: unknown) => string | null): Tool {
  return {
    ...tool,
    needs_approval: async (input) => refusal(input) === null && (await asks_before(tool, input)),
    execute: async (input, ctx) => {
      const why = refusal(input);
      if (why !== null) throw new Error(why);
      return tool.execute(input, ctx);
    },
  };
}

/** The path a write names, or a path that names nothing a gate matches. */
function path_of(input: unknown): string {
  const path = typeof input === 'object' && input !== null ? (input as { path?: unknown }).path : undefined;
  return typeof path === 'string' ? path : '';
}

/** What one session gives the seats and the check: the builder's six
 * workspace tools plus `finish`, asking through `session.approve`; the
 * critic's three reads out of the same set; the tester's reads and confined
 * writes, asking through the session too; and the check's environment,
 * the same as the builder's commands get, with an approval that asks through
 * the session exactly when the builder's `run_command` would ask before
 * running the same command. */
export function acp_seat_tools(
  session: AcpSession,
  options: AcpToolOptions = {},
): {
  builder: AcpSeatTools & { on_tool_approval: ToolApprovalHandler };
  critic: AcpSeatTools;
  tester: AcpSeatTools & { on_tool_approval: ToolApprovalHandler };
  check: CheckGate;
} {
  const env = command_env(options.env ?? process.env);
  const tools = workspace_tools(session, { ignore: [...IGNORED_DIRS], command_env: env });
  const run_command = tools.find((tool) => tool.name === 'run_command');
  const gate_paths = options.gate_paths ?? [];
  const refusal = (input: unknown): string | null =>
    tester_refusal(session.cwd, gate_paths, path_of(input));
  return {
    builder: {
      tools: [...tools, finish_tool()],
      tool_set: 'acp',
      on_tool_approval: session.approve,
    },
    critic: { tools: tools.filter((tool) => CRITIC_READS.has(tool.name)), tool_set: 'acp' },
    tester: {
      tools: tools.flatMap((tool) => {
        if (CRITIC_READS.has(tool.name)) return [tool];
        return TESTER_WRITES.has(tool.name) ? [confined(tool, refusal)] : [];
      }),
      tool_set: 'acp',
      on_tool_approval: session.approve,
    },
    check: {
      env,
      on_approval: async (request) =>
        (await asks_before(run_command, request.input)) ? session.approve(request) : true,
    },
  };
}
