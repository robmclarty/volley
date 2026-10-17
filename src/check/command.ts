/**
 * Generic command runner: `sh -c <command>`, combined
 * output captured, exit-0 semantics. Command-not-found is an operator error
 * (exit 4), not an iterable failure.
 */
import { check_error } from '../types.js';
import type { CheckResult, CheckRunnerKind } from '../types.js';
import { spawn_capture } from './checkride.js';
import type { CheckSpawnOptions } from './checkride.js';

export type CommandCheckOpts = CheckSpawnOptions & {
  command: string;
  workspace: string;
};

export async function run_command_check(opts: CommandCheckOpts): Promise<CheckResult> {
  const { command, workspace, ...spawn_options } = opts;
  const started = Date.now();
  const proc = await spawn_capture('sh', ['-c', command], { ...spawn_options, cwd: workspace });
  // sh reports 127 for command-not-found and 126 for not-executable.
  if (proc.exit_code === 127 || proc.exit_code === 126) {
    throw check_error(
      `check command failed to start (exit ${String(proc.exit_code)}): ${command}`,
    );
  }
  const log = `${proc.stdout}${proc.stderr}`;
  return {
    ran: true,
    runner: 'command',
    ok: proc.exit_code === 0,
    exit_code: proc.exit_code,
    duration_ms: Date.now() - started,
    failing_slots: [],
    detail: [],
    log,
  };
}

export function skipped_check(reason: 'none' | 'cost_cap'): CheckResult {
  return {
    ran: false,
    runner: 'none',
    // With no check configured the loop is critic-gated only, so the gate is
    // open (`ok: true`). A cost-cap skip must not look like a passing gate.
    ok: reason === 'none',
    exit_code: null,
    duration_ms: 0,
    failing_slots: [],
    detail: [],
  };
}

/** What a rejected check says in place of its output. */
export const CHECK_REJECTED = 'the check was rejected when it asked to run, so it never ran';

/** A check the user rejected when it asked to run: recorded as a failed
 * check, with the refusal as its output, so a round can't converge on work
 * nothing checked, and the critic hears why there's no result. */
export function rejected_check(runner: CheckRunnerKind): CheckResult {
  return {
    ran: true,
    runner,
    ok: false,
    exit_code: null,
    duration_ms: 0,
    failing_slots: [],
    detail: [],
    log: CHECK_REJECTED,
  };
}
