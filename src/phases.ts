/**
 * The step bodies behind the nodes of `./flow.ts`, one function per node. Each
 * takes the loop's carry-state and returns the next one. The phase modules they
 * call (`./builder.ts`, `./check/`, `./critic/`) do the work; these bodies add
 * what surrounds it: the renderer lines an operator watches, change detection,
 * git checkpoints, the per-iteration archive, and the progress events a
 * trajectory reader follows the run by.
 */
import { aborted_error } from 'fascicle';
import type { RunContext, StreamChunk, ToolApprovalHandler } from 'fascicle';
import { run_builder } from './builder.js';
import type { BuilderStep } from './builder.js';
import { collect_changes } from './changes.js';
import { run_checkride } from './check/checkride.js';
import { CHECK_REJECTED, rejected_check, run_command_check, skipped_check } from './check/command.js';
import { run_critic } from './critic/run.js';
import type { CriticStep } from './critic/run.js';
import { archive_iteration, run_result_from_state } from './iteration.js';
import type { Renderer } from './render/renderer.js';
import { write_run_summary } from './summary.js';
import { error_kind, phase_error } from './types.js';
import type { ChangeSet, CheckResult, LoopState, ResolvedConfig, Verdict } from './types.js';
import { git_checkpoint } from './workspace.js';
import { build_root } from './worktree.js';

/** A round starting, emitted as the build opens it. */
export type RoundStartEvent = { volley: 'round_start'; round: number };

/** The check starting, with the command line it runs. */
export type CheckStartEvent = { volley: 'check_start'; round: number; command: string };

/** The check's outcome. */
export type CheckEndEvent = {
  volley: 'check_end';
  round: number;
  ok: boolean;
  exit_code: number | null;
  failing_slots: string[];
  duration_ms: number;
};

/** The critic's verdict, with what it still found missing, and whether it
 * came from the tool-less fallback. */
export type VerdictEvent = {
  volley: 'verdict';
  round: number;
  verdict: Verdict;
  feedback: string;
  unmet_criteria: string[];
  degraded: boolean;
};

/** The progress events the phases emit through `ctx.emit`, discriminated by
 * `volley`, since `ctx.emit` overwrites `kind` with `'emit'`. A CLI run's
 * trajectory keeps them for a viewer, and under acp they become the round
 * lines, the verdict thought, and the rest of what the editor shows. */
export type PhaseEvent = RoundStartEvent | CheckStartEvent | CheckEndEvent | VerdictEvent;

/** The step id the check's card is recorded under: the check step's own, in
 * `./flow.ts`, so each round's check counts as a fresh run of it and opens a
 * card of its own. */
export const CHECK_STEP_ID = 'check';

/** The raw call id and tool name of the check's card. The name sits outside
 * the workspace tools, so nothing dresses the card as one of theirs. */
const CHECK_CALL = { id: 'check', name: 'check' } as const;

function emit(ctx: RunContext, event: PhaseEvent): void {
  ctx.emit(event);
}

/** Record one chunk of the check's card, the way `model_call` records a tool
 * call's, under a streamed run only, since nothing reads a card otherwise. */
function record_check_chunk(ctx: RunContext, chunk: StreamChunk): void {
  if (ctx.streaming) ctx.trajectory.record({ kind: 'model_chunk', step_id: CHECK_STEP_ID, chunk });
}

/** The command line the check runs, or null when no check is configured. */
function check_command(config: ResolvedConfig): string | null {
  if (config.check_resolved === 'checkride') return 'pnpm exec checkride --json';
  if (config.check_resolved === 'command') return config.check;
  return null;
}

/** How the check runs when the caller sets it, as `volley acp` does. Left
 * out, the check inherits volley's environment and runs unasked, as on the
 * CLI. */
export type CheckGate = {
  /** The whole environment the check runs with, in place of volley's own. */
  env?: Readonly<Record<string, string>>;
  /** Asked on the check's card before each check, the way a model call asks
   * before a gated tool runs. Anything short of an allow keeps the check from
   * running, and it's recorded as failed. */
  on_approval?: ToolApprovalHandler;
};

/** What every step body closes over, fixed for the whole run. */
export type PhaseDeps = {
  config: ResolvedConfig;
  renderer: Renderer;
  /** The commit every iteration's change set is measured against, read after
   * the worktree exists and before the builder writes anything. Null when the
   * build root is not a git repo — then the run reports no changes at all
   * rather than guessing at them. */
  baseline: string | null;
  check?: CheckGate;
};

/** How many gate edits a warning names before it summarises the rest. */
const LISTED_GATE_EDITS = 5;

/**
 * Say what the builder reached for, every iteration. The count is an info line;
 * a gate edit is a warning, because it is the fact that changes how much a green
 * check is worth — and the operator should hear it from the harness rather than
 * discover it in the diff afterwards (the by-hand check that
 * `research/reckon-local-run-finding.md` recommends making routine).
 */
function report_changes(
  config: ResolvedConfig,
  renderer: Renderer,
  changes: ChangeSet | null,
): void {
  if (changes === null) return;
  renderer.info(
    `changes: ${String(changes.total)} file(s) changed since the run baseline` +
      (changes.truncated ? ` (listing the first ${String(changes.files.length)})` : ''),
  );
  if (changes.gate_edits.length === 0) return;
  const hidden = changes.gate_edits.length - LISTED_GATE_EDITS;
  const listed = changes.gate_edits.slice(0, LISTED_GATE_EDITS).join(', ');
  renderer.warn(
    `gate edit: the builder changed ${String(changes.gate_edits.length)} file(s) that decide ` +
      `whether its work passes — ${listed}${hidden > 0 ? ` (+${String(hidden)} more)` : ''}. ` +
      'A green check proves less when the builder can edit the gate; the critic is told about ' +
      'this and the run summary records it.' +
      // The halt lands at the loop guard, after this iteration's check and
      // critic have had their say — so promise the outcome, not the timing.
      (config.fail_on_gate_edit
        ? ' This run will end without success (--fail-on-gate-edit, exit 8).'
        : ''),
  );
}

/** Run the configured check, checkride or a command, with the environment
 * the caller set for it, else volley's own. */
async function execute_check(deps: PhaseDeps, abort: AbortSignal): Promise<CheckResult> {
  const { config } = deps;
  // The check gates the tree the builder actually wrote: the worktree
  // under `--worktree`, else the workspace.
  const root = build_root(config.workspace, config.worktree);
  const options = { abort, ...(deps.check?.env !== undefined ? { env: deps.check.env } : {}) };
  return config.check_resolved === 'checkride'
    ? run_checkride({ ...options, workspace: root })
    : run_command_check({ ...options, command: config.check, workspace: root });
}

/** Whether the check may run `command`: yes, unless the caller set an
 * approval and it answers no. It asks on the check's card under the command
 * line as its tool name, which titles the prompt the way the card is titled,
 * and which names none of fascicle's gated tools, so the prompt offers Allow
 * and Reject alone, never an "always" that would cover the builder's commands
 * too. A stop while it asks ends the check as a stop, not a rejection. */
async function check_allowed(
  deps: PhaseDeps,
  command: string,
  abort: AbortSignal,
): Promise<boolean> {
  const approve = deps.check?.on_approval;
  if (approve === undefined) return true;
  const allowed = await approve({
    tool_name: command,
    input: { command },
    tool_call_id: CHECK_CALL.id,
    step_index: 0,
    abort,
  });
  if (abort.aborted) throw new aborted_error('check aborted');
  return allowed;
}

/** Open the next iteration: advance the counter and clear every per-iteration
 * field, so nothing from the last round leaks into this one. */
function next_iteration(s: LoopState): LoopState {
  return {
    ...s,
    iteration: s.iteration + 1,
    iteration_started_at: new Date().toISOString(),
    iteration_cost_usd: 0,
    builder: null,
    critic: null,
    check: null,
    verdict: null,
    unmet_criteria: [],
  };
}

/** `build`: one builder session edits the build root, then volley measures what
 * it changed and, under `--git`, checkpoints it. */
export async function build_phase(
  deps: PhaseDeps,
  builder: BuilderStep,
  s: LoopState,
  ctx: RunContext,
): Promise<LoopState> {
  const { config, renderer } = deps;
  const next = next_iteration(s);
  emit(ctx, { volley: 'round_start', round: next.iteration });
  renderer.phase_start(next.iteration, 'builder');
  const built = await run_builder({ builder, config, warn: renderer.warn }, next, ctx);
  renderer.phase_end(built.iteration, 'builder', true);
  renderer.cost_line(
    built.iteration,
    'builder',
    built.builder?.cost_usd ?? null,
    built.total_cost_usd,
  );
  if (built.cost_warned && !s.cost_warned) {
    renderer.warn('cost unavailable for this phase; recording null (run totals sum what is known)');
  }
  // What the builder actually did, measured before the check runs — so the
  // check's verdict and the builder's reach are two independent facts about
  // the same iteration rather than one inferred from the other.
  const changes = collect_changes({
    root: build_root(config.workspace, config.worktree),
    baseline: deps.baseline,
    gate_patterns: config.gate_paths,
  });
  report_changes(config, renderer, changes);
  if (config.git_checkpoints) {
    git_checkpoint(
      build_root(config.workspace, config.worktree),
      `volley iter ${String(built.iteration)}: build`,
    );
  }
  return { ...built, changes };
}

/** `skip_verify`: the build alone crossed the cost cap, so the check is recorded
 * as skipped and no critic is called — a doomed iteration spends nothing more.
 * The loop guard then halts the run on the cap. */
export function skip_verify_phase(deps: PhaseDeps, s: LoopState): LoopState {
  deps.renderer.warn('cost cap crossed during build; skipping check and critic');
  return { ...s, check: skipped_check('cost_cap') };
}

/** Open the check's card on a streamed run: the call's start, then the
 * command as its input, the two chunks `model_call` records for a tool call
 * before it runs. */
function open_check_card(ctx: RunContext, command: string): void {
  record_check_chunk(ctx, { kind: 'tool_call_start', ...CHECK_CALL, step_index: 0 });
  record_check_chunk(ctx, { kind: 'tool_call_end', id: CHECK_CALL.id, input: { command }, step_index: 0 });
}

/** Close the check's card with its result, which the card's reader renders,
 * or with the error that stopped the check before it had one. */
function close_check_card(ctx: RunContext, outcome: { result: CheckResult } | { error: unknown }): void {
  record_check_chunk(
    ctx,
    'result' in outcome
      ? { kind: 'tool_result', id: CHECK_CALL.id, output: outcome.result, step_index: 0 }
      : {
          kind: 'tool_result',
          id: CHECK_CALL.id,
          error: {
            message: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
          },
          step_index: 0,
        },
  );
}

/** `check`: the deterministic gate over the tree the builder wrote. A check
 * that runs a command emits its start and end, and on a streamed run also
 * records its card as a tool call, so a reader of the stream shows it running
 * while it runs. When the caller set an approval, the check asks on that card
 * first, and a rejected check closes it failed and is recorded as failed. */
export async function check_phase(
  deps: PhaseDeps,
  s: LoopState,
  ctx: RunContext,
): Promise<LoopState> {
  const { config, renderer } = deps;
  renderer.phase_start(s.iteration, 'check');
  const command = check_command(config);
  if (command === null) {
    renderer.info('no deterministic check configured; loop is critic-gated only');
    return { ...s, check: skipped_check('none') };
  }
  emit(ctx, { volley: 'check_start', round: s.iteration, command });
  open_check_card(ctx, command);
  try {
    const allowed = await check_allowed(deps, command, ctx.abort);
    const result = allowed
      ? await execute_check(deps, ctx.abort)
      : rejected_check(config.check_resolved);
    close_check_card(ctx, allowed ? { result } : { error: CHECK_REJECTED });
    emit(ctx, {
      volley: 'check_end',
      round: s.iteration,
      ok: result.ok,
      exit_code: result.exit_code,
      failing_slots: result.failing_slots,
      duration_ms: result.duration_ms,
    });
    renderer.phase_end(
      s.iteration,
      'check',
      result.ok,
      !allowed
        ? 'rejected'
        : result.failing_slots.length > 0
          ? `failing: ${result.failing_slots.join(', ')}`
          : undefined,
    );
    return {
      ...s,
      check: result,
      check_duration_ms: s.check_duration_ms + result.duration_ms,
    };
  } catch (err) {
    close_check_card(ctx, { error: err });
    if (error_kind(err) === 'check_error') throw err;
    throw phase_error('check', s.iteration, err);
  }
}

/** `critique`: the read-only critic's verdict, feedback, and unmet criteria. */
export async function critique_phase(
  deps: PhaseDeps,
  critic: CriticStep,
  s: LoopState,
  ctx: RunContext,
): Promise<LoopState> {
  const { renderer } = deps;
  renderer.phase_start(s.iteration, 'critic');
  const critiqued = await run_critic({ critic, config: deps.config }, s, ctx);
  if (critiqued.verdict !== null) {
    emit(ctx, {
      volley: 'verdict',
      round: critiqued.iteration,
      verdict: critiqued.verdict,
      feedback: critiqued.feedback ?? '',
      unmet_criteria: critiqued.unmet_criteria,
      degraded: critiqued.critic?.critic_degraded === true,
    });
  }
  renderer.phase_end(
    critiqued.iteration,
    'critic',
    critiqued.verdict === 'approved',
    critiqued.verdict ?? undefined,
  );
  renderer.cost_line(
    critiqued.iteration,
    'critic',
    critiqued.critic?.cost_usd ?? null,
    critiqued.total_cost_usd,
  );
  return critiqued;
}

/** `record`: archive the iteration and rewrite the run summary, so the on-disk
 * state is consistent after every round (resume reads it back). */
export function record_phase(deps: PhaseDeps, s: LoopState): LoopState {
  const { config } = deps;
  archive_iteration(config, s);
  write_run_summary(config, run_result_from_state(config, s, 'running', null));
  if (config.git_checkpoints) {
    git_checkpoint(
      build_root(config.workspace, config.worktree),
      `volley iter ${String(s.iteration)}: critique (${s.verdict ?? 'skipped'})`,
    );
  }
  return s;
}
