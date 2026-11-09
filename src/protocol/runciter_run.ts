/**
 * runciter's run protocol, `runciter.run/1` (runciter's spec §5.4), as volley
 * speaks it: the `RunInput` runciter writes on a run child's stdin, the
 * `RunOutput` the child writes on its stdout, and the two mappings between them
 * and a volley run.
 *
 * runciter used to reach volley only through a `volley` kind in its own repo,
 * which pinned volley's version range, read its `summary.json`, and broke each
 * time volley moved (move 1's Frame). With the protocol spoken here, runciter's
 * `process` kind runs volley with no adapter. The schemas are volley's own copy,
 * transcribed field for field from runciter's `src/protocol/`, with no
 * dependency on runciter (D10): a builder shouldn't need its host to build, and
 * runciter's conformance test is what checks the two copies agree.
 *
 * The mappings follow what runciter's `volley` kind did, so a task runs the
 * same either way: the prompt is the agent's body and then `context.md`, which
 * carries the task and its feedback (D24); the check is the stage's verify, as
 * runciter's own verify reads it (D25); and the state goes in the run directory,
 * never the workspace runciter diffs (D26).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  EXIT_CHECK_ERROR,
  EXIT_CRITIC_ERROR,
  EXIT_INTERRUPTED,
  exit_code_for_error,
  exit_code_for_status,
} from '../exit_codes.js';
import type { RunSummary } from '../summary.js';
import { config_error } from '../types.js';
import type { RunStatus, VolleyConfig } from '../types.js';

/** The protocol's name and version; every `RunInput` and `RunOutput` carries
 * it. */
export const RUN_PROTOCOL = 'runciter.run/1';

/** The fail reasons a runner may report (runciter's `RUNNER_FAIL_REASONS`).
 * runciter assigns the rest of its vocabulary itself. */
const RUNNER_FAIL_REASONS = [
  'not_passed',
  'iterations_exhausted',
  'builder_error',
  'check_error',
  'critic_error',
  'gate_edit_blocked',
  'interrupted',
  'cost_cap',
] as const;

export type RunnerFailReason = (typeof RUNNER_FAIL_REASONS)[number];

/** How a run child executes, as runciter names it (§5.5). */
const RUNNER_KINDS = ['process', 'module', 'prompt', 'volley', 'acp', 'cli', 'command', 'noop'] as const;

/** The most a `RunOutput`'s summary and detail may hold. */
export const SUMMARY_MAX_CHARS = 4000;
const DETAIL_MAX_CHARS = 4000;

/** A lesson's statement, as runciter records it. */
const STATEMENT_MAX_CHARS = 1000;

const id = z.string().min(1);
const path = z.string().min(1);
const gate = z.enum(['auto', 'human']);
const workspace_kind = z.enum(['scratch', 'worktree']);

/** `RunInput` (§5.4). A key this schema doesn't know is dropped, not refused,
 * so volley keeps working against a newer runciter. */
export const run_input_schema = z.object({
  protocol: z.literal(RUN_PROTOCOL),
  run_id: id,
  task: z.object({
    id,
    title: z.string(),
    body: z.string(),
    criteria: z.string(),
    labels: z.array(z.string()),
    priority: z.number().int(),
    repo_path: z.string().nullable(),
  }),
  pipeline: z.object({ id, hash: id }),
  /** `verify` is `none`, `auto`, or a shell command. */
  stage: z.object({
    id,
    label: z.string(),
    gate,
    workspace: workspace_kind,
    verify: z.string(),
  }),
  /** `config` is the agent's normalized frontmatter, and `prompt` its body. */
  agent: z.object({
    id,
    hash: id,
    runner: z.enum(RUNNER_KINDS),
    config: z.record(z.string(), z.unknown()),
    prompt: z.string(),
  }),
  /** `path` is the child's cwd, and writable. The branch fields are set for
   * worktrees only. */
  workspace: z.object({
    kind: workspace_kind,
    path,
    branch: z.string().nullable(),
    base_branch: z.string().nullable(),
    base_commit: z.string().nullable(),
  }),
  /** Writable; artifacts go in `<run_dir>/artifacts/`. */
  run_dir: path,
  context: z.object({ markdown_path: path, pack_path: path }),
  /** The context pack's feedback section, also inlined in `context.md`. */
  feedback: z.string().nullable(),
  budget: z.object({
    max_cost_usd: z.number().positive().nullable(),
    timeout_ms: z.number().positive(),
  }),
});

export type RunciterRunInput = z.output<typeof run_input_schema>;

const text = z.string().min(1);

const artifact_schema = z.strictObject({
  name: text,
  path: text,
  media_type: text.optional(),
  title: z.string().optional(),
});

export type RunArtifact = z.output<typeof artifact_schema>;

/** `RunOutput` (§5.4). Strict: a misspelled or unknown key is runciter's
 * `protocol_error`, so a field is never silently lost. */
export const run_output_schema = z
  .strictObject({
    protocol: z.literal(RUN_PROTOCOL),
    status: z.enum(['passed', 'failed']),
    summary: text.max(SUMMARY_MAX_CHARS),
    /** Required when failed. */
    fail_reason: z.enum(RUNNER_FAIL_REASONS).optional(),
    detail: z.string().max(DETAIL_MAX_CHARS).optional(),
    /** Each path relative to `<run_dir>/artifacts`. */
    artifacts: z.array(artifact_schema).optional(),
    proposed: z
      .strictObject({
        title: z.string().optional(),
        body: z.string().optional(),
        criteria: z.string().optional(),
        labels: z.array(z.string()).optional(),
      })
      .optional(),
    follow_ups: z
      .array(
        z.strictObject({
          title: text,
          body: z.string().optional(),
          labels: z.array(z.string()).optional(),
        }),
      )
      .optional(),
    lessons: z
      .array(
        z.strictObject({
          statement: text.max(STATEMENT_MAX_CHARS),
          scope: z
            .strictObject({
              stage: z.string().optional(),
              agent: z.string().optional(),
              labels: z.array(z.string()).optional(),
            })
            .optional(),
        }),
      )
      .optional(),
    usage: z
      .strictObject({
        cost_usd: z.number().nonnegative().optional(),
        cost_source: z.enum(['reported', 'estimated']).optional(),
        input_tokens: z.number().int().nonnegative().optional(),
        output_tokens: z.number().int().nonnegative().optional(),
      })
      .optional(),
    /** The agent's session id; runciter stores it and doesn't use it yet. */
    session_ref: z.string().optional(),
    /** Runner-specific; runciter stores it verbatim in `data.json`. */
    data: z.unknown().optional(),
  })
  .refine((output) => output.status === 'passed' || output.fail_reason !== undefined, {
    message: 'is required when status is failed',
    path: ['fail_reason'],
  });

export type RunciterRunOutput = z.output<typeof run_output_schema>;

/** What the agent's argv set, as `VolleyConfig` names it, with `--run-id`
 * beside it. Its `check`, `state_dir` and `run_id` win over what the input
 * would give; everything else it sets passes through. */
export type ProtocolFlags = Partial<VolleyConfig> & { run_id?: string };

/** Where protocol mode keeps the run's state under the run directory: volley
 * makes `<run_dir>/volley/<run_id>/` of it, outside the workspace (D26). */
const STATE_ROOT = 'volley';

/** The critic's last feedback, as an artifact in `<run_dir>/artifacts/` (D26). */
export const CRITIC_FEEDBACK_ARTIFACT: RunArtifact = {
  name: 'critic-feedback.md',
  path: 'critic-feedback.md',
  media_type: 'text/markdown',
  title: 'Critic feedback',
};

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a `package.json`'s text declares a `check` script. Text that isn't
 * a JSON object declares none. */
function has_check_script(package_json: string | null): boolean {
  if (package_json === null) return false;
  try {
    const parsed: unknown = JSON.parse(package_json);
    return is_record(parsed) && is_record(parsed['scripts']) && typeof parsed['scripts']['check'] === 'string';
  } catch {
    return false;
  }
}

function read_package_json(workspace: string): string | null {
  try {
    return readFileSync(join(workspace, 'package.json'), 'utf8');
  } catch {
    return null;
  }
}

/** The check a stage's `verify` names, read as runciter's own verify reads it,
 * so volley converges on the gate runciter checks afterwards (D25): `none` and a
 * command pass through, and `auto` is `pnpm check` when the workspace's
 * `package.json` has a check script, else `none`. volley's own `auto` would look
 * for checkride instead, and could pass where runciter's verify fails. */
export function check_from_verify(verify: string, package_json: string | null): string {
  if (verify !== 'auto') return verify;
  return has_check_script(package_json) ? 'pnpm check' : 'none';
}

/** The text of the input's `context.md`. Unreadable, the input is bad, which
 * protocol mode reports as a contract violation. */
function read_context(input: RunciterRunInput): string {
  try {
    return readFileSync(input.context.markdown_path, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw config_error(
      `the RunInput's context.markdown_path can't be read: ${input.context.markdown_path} (${reason})`,
    );
  }
}

/** The agent's body, then `context.md`, each trimmed, blank parts left out,
 * as runciter's `volley` kind wrote `prompt.md` (D24). */
function prompt_of(input: RunciterRunInput): string {
  return [input.agent.prompt, read_context(input)]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('\n\n');
}

/**
 * The volley config a `RunInput` asks for, over what the agent's argv set
 * (`flags`), and the run id to resolve it with. The input sets the prompt
 * (D24), the criteria, the workspace, and the cost cap when runciter gives one;
 * the argv's `check`, `state_dir` and `run_id` win over the stage's verify
 * (D25), `<run_dir>/volley` and the input's `run_id` (D26). `budget.timeout_ms`
 * is ignored: runciter stops the run itself, with SIGTERM.
 */
export function input_to_config(
  input: RunciterRunInput,
  flags: ProtocolFlags = {},
): { config: VolleyConfig; run_id: string } {
  const { run_id: flag_run_id, ...argv } = flags;
  const max_cost_usd = input.budget.max_cost_usd ?? argv.max_cost_usd;
  const config: VolleyConfig = {
    ...argv,
    prompt: prompt_of(input),
    criteria: input.task.criteria,
    workspace: input.workspace.path,
    check: argv.check ?? check_from_verify(input.stage.verify, read_package_json(input.workspace.path)),
    state_dir: argv.state_dir ?? join(input.run_dir, STATE_ROOT),
    ...(max_cost_usd !== undefined ? { max_cost_usd } : {}),
  };
  return { config, run_id: flag_run_id ?? input.run_id };
}

/** The fail reason for a run that ended on an error, by the phase the error
 * names, the way volley's own exit code names it (D28): 3, 4 and 6 are the
 * builder, the check and the critic. A tester's error exits as a builder's,
 * since runciter has no reason for a tester. */
function error_fail_reason(error: unknown): RunnerFailReason {
  const code = error === undefined ? exit_code_for_status('error') : exit_code_for_error(error);
  if (code === EXIT_CHECK_ERROR) return 'check_error';
  if (code === EXIT_CRITIC_ERROR) return 'critic_error';
  if (code === EXIT_INTERRUPTED) return 'interrupted';
  return 'builder_error';
}

/** An error's message, or nothing when there's no error or it says nothing. */
function error_detail(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  return error === undefined || message === '' ? null : cut(message, DETAIL_MAX_CHARS);
}

/** The fail reason for a run that didn't pass, by its status, or null for a
 * pass. Any status without a reason of its own, `tester_passed_early` among
 * them, is `not_passed`. */
export function fail_reason_of(status: RunStatus, error?: unknown): RunnerFailReason | null {
  switch (status) {
    case 'success':
      return null;
    case 'budget_exhausted':
      return 'iterations_exhausted';
    case 'cost_cap_reached':
      return 'cost_cap';
    case 'gate_edit_blocked':
      return 'gate_edit_blocked';
    case 'interrupted':
      return 'interrupted';
    case 'error':
      return error_fail_reason(error);
    default:
      return 'not_passed';
  }
}

function cut(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function plural(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}

/** What else goes into a `RunOutput` beside the summary: the critic's last
 * feedback (`feedback.md`), the artifacts copied into `<run_dir>/artifacts/`,
 * and what threw, when the run ended on an error. */
export type OutputExtras = {
  feedback?: string | null;
  artifacts?: RunArtifact[];
  error?: unknown;
};

/**
 * The `RunOutput` for a finished run (D12): `passed` on `success`, else
 * `failed` with a reason from runciter's vocabulary; a summary that is a status
 * line and then the critic's last feedback, cut to 4000 characters, never
 * empty; the run's totals as usage, an estimate, as Claude Code's cost is; the
 * summary whole as `data`; the artifacts it was handed; and no lessons. An
 * error's message is the detail.
 */
export function result_to_output(summary: RunSummary, extras: OutputExtras = {}): RunciterRunOutput {
  const reason = fail_reason_of(summary.status, extras.error);
  const status_line =
    `volley: ${summary.status} after ${plural(summary.iterations_completed, 'iteration')}, ` +
    `verdict ${summary.final_verdict ?? 'none'}.`;
  const feedback = extras.feedback?.trim() ?? '';
  const artifacts = extras.artifacts ?? [];
  const detail = error_detail(extras.error);
  return {
    protocol: RUN_PROTOCOL,
    status: reason === null ? 'passed' : 'failed',
    summary: cut(feedback === '' ? status_line : `${status_line}\n\n${feedback}`, SUMMARY_MAX_CHARS),
    ...(reason === null ? {} : { fail_reason: reason }),
    ...(detail === null ? {} : { detail }),
    ...(artifacts.length === 0 ? {} : { artifacts }),
    lessons: [],
    usage: {
      cost_usd: summary.total_cost_usd,
      cost_source: 'estimated',
      input_tokens: summary.total_usage.input_tokens,
      output_tokens: summary.total_usage.output_tokens,
    },
    data: summary,
  };
}
