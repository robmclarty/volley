/**
 * Iteration archiving, run-level summary, and resume-state recovery.
 * `feedback.md` and `verdict` are harness-written projections
 * of the critic's validated structured output.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { EMPTY_USAGE } from './cost.js';
import { config_error } from './types.js';
import type {
  BuilderPermissionMode,
  BuilderProvider,
  CriticProvider,
  LoopState,
  PhaseRecord,
  ResolvedConfig,
  RunResult,
  RunStatus,
  Verdict,
  VolleyConfig,
} from './types.js';
import { iteration_dir, RUN_ID_PATTERN, run_state_dir, state_path } from './workspace.js';

function write_json(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function persist_verdict_files(
  config: ResolvedConfig,
  feedback: string,
  verdict: Verdict,
): void {
  writeFileSync(state_path(config, 'feedback.md'), feedback.endsWith('\n') ? feedback : `${feedback}\n`);
  writeFileSync(state_path(config, 'verdict'), `${verdict}\n`);
}

function phase_summary(record: PhaseRecord | null): Record<string, unknown> | null {
  if (record === null) return null;
  return {
    provider: record.provider,
    model: record.model,
    session_id: record.session_id,
    duration_ms: record.duration_ms,
    usage: record.usage,
    cost_usd: record.cost_usd,
    cost_source: record.cost_source,
    finish_reason: record.finish_reason,
    tool_calls: record.tool_calls,
    salvaged_tool_calls: record.salvaged_tool_calls,
    // Salvage rate (a health metric): the share of tool calls recovered from
    // assistant text. A high rate on a local run means the model's native
    // tool-call encoding is drifting from its runtime's parser (pin them as one
    // unit). 0 when the phase made no tool calls (the CLI builder's own loop).
    salvage_rate: record.tool_calls === 0 ? 0 : record.salvaged_tool_calls / record.tool_calls,
    // Degradation-ladder bookkeeping, critic-only: the provider-error
    // retries that preceded this verdict, their cause, whether it was rendered
    // by the tool-less fallback, and why. Emitted only when set, so the builder
    // record and old summary consumers are untouched. `critic_degraded` and
    // `degrade_cause` are the on-disk half of the contract — the comparison
    // block reads them back from here.
    ...(record.retries !== undefined ? { retries: record.retries } : {}),
    ...(record.retry_cause_kind !== undefined
      ? { retry_cause_kind: record.retry_cause_kind }
      : {}),
    ...(record.critic_degraded === true ? { critic_degraded: true } : {}),
    ...(record.degrade_cause !== undefined ? { degrade_cause: record.degrade_cause } : {}),
    // Model speed, where fascicle could time the turns (never `claude_cli`).
    // Emitted only when measured. Additive.
    ...(record.throughput !== undefined ? { throughput: record.throughput } : {}),
  };
}

/** Archive one completed iteration: verdict files, check artifacts, and the
 * per-iteration summary. */
export function archive_iteration(config: ResolvedConfig, state: LoopState): void {
  const dir = iteration_dir(config, state.iteration);
  mkdirSync(join(dir, 'check'), { recursive: true });

  if (state.verdict !== null && state.feedback !== null) {
    persist_verdict_files(config, state.feedback, state.verdict);
    writeFileSync(join(dir, 'feedback.md'), readFileSync(state_path(config, 'feedback.md')));
    writeFileSync(join(dir, 'verdict'), `${state.verdict}\n`);
  }

  const check = state.check;
  if (check !== null && check.ran) {
    if (check.runner === 'checkride') {
      if (check.summary !== undefined) {
        write_json(join(dir, 'check', 'summary.json'), check.summary);
      }
      for (const artifact of check.detail) {
        if (artifact.path !== null && existsSync(artifact.path)) {
          writeFileSync(join(dir, 'check', basename(artifact.path)), readFileSync(artifact.path));
        }
      }
    } else {
      writeFileSync(join(dir, 'check', 'check.log'), check.log ?? '');
      writeFileSync(join(dir, 'check', 'check.exit'), `${String(check.exit_code)}\n`);
    }
  }

  const completed_at = new Date().toISOString();
  write_json(join(dir, 'summary.json'), {
    iteration: state.iteration,
    started_at: state.iteration_started_at,
    completed_at,
    duration_ms: Date.parse(completed_at) - Date.parse(state.iteration_started_at),
    builder: phase_summary(state.builder),
    check:
      check === null
        ? null
        : {
            ran: check.ran,
            runner: check.runner,
            ok: check.ok,
            exit_code: check.exit_code,
            duration_ms: check.duration_ms,
            failing_slots: check.failing_slots,
          },
    critic: phase_summary(state.critic),
    // What the builder reached for this iteration (`src/changes.ts`), archived
    // beside the check's verdict so the two can be read against each other after
    // the fact: green + a gate edit is a different result from green alone.
    // Null when the build root is not a git repository. Additive.
    changes: state.changes,
    verdict: state.verdict,
    // The criteria the critic judged unmet, verbatim. The run-level summary
    // reads the last iteration's list, so a non-converged run says what it was
    // still missing when it stopped instead of only that it stopped. Additive.
    unmet_criteria: state.unmet_criteria,
    iteration_cost_usd: state.iteration_cost_usd,
    iteration_total_cost_usd: state.total_cost_usd,
  });
}

export function run_result_from_state(
  config: ResolvedConfig,
  state: LoopState,
  status: RunStatus,
  completed_at: string | null,
): RunResult {
  return {
    run_id: config.run_id,
    status,
    started_at: config.started_at,
    completed_at,
    iterations_completed: state.iteration,
    total_usage: state.total_usage,
    total_cost_usd: state.total_cost_usd,
    builder_cost_usd: state.builder_cost_usd,
    critic_cost_usd: state.critic_cost_usd,
    check_duration_ms: state.check_duration_ms,
    final_verdict: state.verdict,
    // The loop itself never salvages: the orchestrator re-stamps this after
    // teardown when a converged `--worktree` run's work was kept on its branch,
    // which is the only moment the branch's survival is known.
    salvaged_branch: null,
    run_state_dir: run_state_dir(config),
  };
}

export type ResumeState = {
  raw_config: VolleyConfig;
  run_id: string;
  started_at: string;
  state: LoopState;
  iterations_completed: number;
};

/** The run id an older volley's `.volley/config.json` records, or null when
 * there is none to read. */
function legacy_run_id(workspace: string): string | null {
  try {
    const recorded = JSON.parse(readFileSync(join(workspace, '.volley', 'config.json'), 'utf8')) as {
      run_id?: unknown;
    };
    return typeof recorded.run_id === 'string' ? recorded.run_id : null;
  } catch {
    return null;
  }
}

/** Where `volley resume <run_id>` finds a run: under `root` (`--state-dir`,
 * else the default root) at `<root>/<run_id>/`, returned as that root, or, for
 * a run an older volley kept in the workspace, `.volley/`, returned as null so
 * the resumed run stays there. Finding neither is a config error naming both
 * places it looked. The id becomes a path, so it must be one a run could have
 * had. */
export function find_run_state(workspace: string, run_id: string, root: string): string | null {
  if (!RUN_ID_PATTERN.test(run_id)) {
    throw config_error(`not a run id: ${run_id} (letters, digits, '-', and '_', starting with a letter or digit)`);
  }
  if (existsSync(join(root, run_id, 'config.json'))) return root;
  const legacy = legacy_run_id(workspace);
  if (legacy === run_id) return null;
  const holds = legacy === null ? '' : ` (it holds run ${legacy})`;
  throw config_error(
    `run ${run_id} not found in ${join(root, run_id)} or in ${join(resolve(workspace), '.volley')}${holds}; ` +
      'pass --state-dir for the root it ran under, or --workspace for a run kept in .volley/',
  );
}

/** A resumed run writes into its state directory, and a contained run's
 * builder could have written there first, so a symlink anywhere in it would
 * aim the resume's writes, or its pruning of a half-finished iteration, at a
 * file of the host's. volley never makes one, so any is refused. The walk
 * reads each entry's own type and never descends a link, which Node's
 * recursive `readdirSync` would. */
function refuse_symlinks(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw config_error(`refusing to resume: ${path} is a symbolic link, which volley never writes`);
    }
    if (entry.isDirectory()) refuse_symlinks(path);
  }
}

/** Recover a resumable run from its state directory (`.volley/`, or
 * `<state_dir>/<run_id>/` under a state root): settings from config.json,
 * totals from summary.json, feedback from feedback.md. An iteration directory
 * without a summary.json was interrupted mid-phase and is discarded. A
 * directory with a symlink in it is refused before anything is read. */
export function load_resume_state(
  workspace: string,
  run_id: string,
  state_dir: string | null = null,
): ResumeState {
  const run = { workspace, state_dir, run_id };
  const dir = run_state_dir(run);
  if (existsSync(dir)) {
    if (lstatSync(dir).isSymbolicLink()) {
      throw config_error(`refusing to resume: ${dir} is a symbolic link, which volley never writes`);
    }
    refuse_symlinks(dir);
  }
  const config_path = state_path(run, 'config.json');
  if (!existsSync(config_path)) {
    throw config_error(`no resumable run found: ${config_path} missing`);
  }
  const recorded = JSON.parse(readFileSync(config_path, 'utf8')) as Record<string, unknown>;
  if (recorded['run_id'] !== run_id) {
    throw config_error(
      `run ${run_id} not found in ${run_state_dir(run)} (recorded run: ${String(recorded['run_id'])})`,
    );
  }

  const iterations_root = state_path(run, 'iterations');
  const dirs = existsSync(iterations_root)
    ? readdirSync(iterations_root).filter((d) => /^\d{3}$/.test(d)).toSorted()
    : [];
  let completed = 0;
  for (const dir of dirs) {
    const full = join(iterations_root, dir);
    if (existsSync(join(full, 'summary.json'))) {
      completed = Number(dir);
    } else {
      rmSync(full, { recursive: true, force: true });
    }
  }

  const summary_path = state_path(run, 'summary.json');
  const summary = existsSync(summary_path)
    ? (JSON.parse(readFileSync(summary_path, 'utf8')) as RunResult)
    : null;

  const feedback_path = state_path(run, 'feedback.md');
  const feedback = existsSync(feedback_path) ? readFileSync(feedback_path, 'utf8') : null;

  const raw_config: VolleyConfig = {
    prompt: String(recorded['prompt']),
    workspace: String(recorded['workspace']),
    criteria: String(recorded['criteria']),
    check: String(recorded['check']),
    builder_model: String(recorded['builder_model']),
    builder_provider: (recorded['builder_provider'] ?? 'claude_cli') as BuilderProvider,
    ...(typeof recorded['builder_url'] === 'string'
      ? { builder_url: recorded['builder_url'] }
      : {}),
    ...(recorded['builder_max_steps'] === undefined
      ? {}
      : { builder_max_steps: Number(recorded['builder_max_steps']) }),
    critic_model: String(recorded['critic_model']),
    critic_provider: (recorded['critic_provider'] ?? 'claude_cli') as CriticProvider,
    ...(typeof recorded['critic_url'] === 'string' ? { critic_url: recorded['critic_url'] } : {}),
    builder_permission_mode: recorded['builder_permission_mode'] as BuilderPermissionMode,
    critic:
      recorded['critic_preset'] === 'custom'
        ? String(recorded['critic_prompt_path'])
        : String(recorded['critic_preset']),
    max_iterations: Number(recorded['max_iterations']),
    max_cost_usd: recorded['max_cost_usd'] as number | null,
    git_checkpoints: recorded['git_checkpoints'] === true,
    worktree: recorded['worktree'] === true,
    discard_worktree: recorded['discard_worktree'] === true,
    ...(Array.isArray(recorded['gate_paths'])
      ? { gate_paths: recorded['gate_paths'] as string[] }
      : {}),
    fail_on_gate_edit: recorded['fail_on_gate_edit'] === true,
    ...(recorded['sandbox_image'] === undefined
      ? {}
      : { sandbox_image: recorded['sandbox_image'] as string }),
    ...(typeof recorded['state_dir'] === 'string' ? { state_dir: recorded['state_dir'] } : {}),
  };

  const state: LoopState = {
    iteration: completed,
    iteration_started_at: new Date().toISOString(),
    feedback,
    verdict: null,
    unmet_criteria: [],
    check: null,
    // Re-measured by the resumed run's first `build` step, against a baseline
    // captured at resume — a resumed run reports what it changes from there.
    changes: null,
    builder: null,
    critic: null,
    total_usage: summary?.total_usage ?? EMPTY_USAGE,
    total_cost_usd: summary?.total_cost_usd ?? 0,
    builder_cost_usd: summary?.builder_cost_usd ?? 0,
    critic_cost_usd: summary?.critic_cost_usd ?? 0,
    check_duration_ms: summary?.check_duration_ms ?? 0,
    iteration_cost_usd: 0,
    halt: null,
    cost_warned: false,
  };

  return {
    raw_config,
    run_id,
    started_at: String(recorded['started_at']),
    state,
    iterations_completed: completed,
  };
}
