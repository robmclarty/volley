/**
 * Enriched run summary (`.volley/summary.json`): the `RunResult` projection plus
 * a `comparison` block that makes the two blessed examples' runs diff-able.
 * The block gathers the seven comparison metrics — transport,
 * iterations-to-converge, wall-clock, cost, verdict, the deterministic check
 * trajectory, and the local salvage rate — into one self-contained surface so
 * the model-vs-transport write-up (verification §4) reads them from a single
 * object rather than re-deriving them from the per-iteration archive.
 *
 * This is the only writer of `summary.json`; the flow's `record` step calls it
 * every iteration (status `running`, `completed_at` still null), the orchestrator
 * once more with the final status, and — when a `--worktree` run's work was
 * salvaged onto its branch rather than integrated — a third time, to stamp the
 * surviving branch on `salvaged_branch`, which teardown only names after the
 * final status is known.
 * Each write recomputes the comparison from what is currently archived under
 * `.volley/iterations/`, so the trajectory grows as the run does.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type {
  BuilderProvider,
  CriticProvider,
  ResolvedConfig,
  RunResult,
  Verdict,
} from './types.js';
import { volley_path } from './workspace.js';

/** How a role reached the model. volley stays on the `ai_sdk` transport for the
 * local providers (fascicle 0.12.9 defaults `transport` to `'ai_sdk'`, so
 * volley sets no field); `claude_cli` drives Claude through its own CLI
 * subprocess, not an ai-sdk transport at all. Recording both keeps the transport
 * a clean second variable in the comparison (model vs transport). */
export type Transport = 'ai_sdk' | 'claude_cli';

export function transport_of(provider: BuilderProvider | CriticProvider): Transport {
  return provider === 'claude_cli' ? 'claude_cli' : 'ai_sdk';
}

/** One iteration's deterministic-gate outcome, in run order. */
export type CheckTrajectoryPoint = {
  iteration: number;
  ran: boolean;
  ok: boolean;
  failing_slots: string[];
};

/** Run-level salvage aggregate (a health metric): the share of builder tool
 * calls recovered from assistant text rather than returned structurally. A high
 * rate on a local run means the model's native tool-call encoding is drifting
 * from its runtime's parser. `rate` is 0 when the builder made no tool calls
 * (the `claude_cli` builder runs its own loop and reports none). */
export type SalvageStats = {
  tool_calls: number;
  salvaged_tool_calls: number;
  rate: number;
};

/** The self-contained comparison surface the two blessed examples are read
 * through. Cost and verdict echo the `RunResult` top level on
 * purpose — this block is the single object the write-up diffs, so it carries
 * every comparison metric rather than pointing back out for some of them. */
export type ComparisonSummary = {
  builder_transport: Transport;
  critic_transport: Transport;
  /** The iteration the run converged on (check green + critic approved); null
   * when it never converged (budget/cap/interrupt/error). */
  iterations_to_converge: number | null;
  /** Total wall-clock across the run; null until `completed_at` is stamped. */
  wall_clock_ms: number | null;
  total_cost_usd: number;
  builder_cost_usd: number;
  critic_cost_usd: number;
  final_verdict: Verdict | null;
  check_trajectory: CheckTrajectoryPoint[];
  local_salvage: SalvageStats;
  /** Every gate path any iteration's builder edited — the tests, fixtures, and
   * check configuration that decide whether its own work passes (`src/changes.ts`).
   * Empty on a run that only touched the implementation, which is the shape of
   * the by-hand verification `research/reckon-local-run-finding.md` recommends
   * making routine: a green check plus an empty list is worth more than a green
   * check alone. Sorted and de-duplicated across iterations. */
  gate_edits: string[];
  /** What the critic still judged unmet when the run stopped — the last
   * iteration's `unmet_criteria`, verbatim. Empty on a converged run. This is the
   * "why not" a non-success status alone cannot give: `budget_exhausted` says the
   * run ran out of iterations, not what it was still missing. */
  unmet_criteria: string[];
  /** Any iteration's critic verdict was rendered by the tool-less fallback:
   * the tool-bearing critique kept dying on the provider's stream, so
   * the critic judged without read access — real, but shallower. The run's
   * headline honesty flag, and the "degraded" column the matrix runner
   * reads straight from this block. */
  critic_degraded: boolean;
};

/** `RunResult` plus the comparison block; `.volley/summary.json` mirrors this. */
export type RunSummary = RunResult & { comparison: ComparisonSummary };

/** The subset of an archived per-iteration summary (written by
 * `archive_iteration`) the comparison block reads. Every field is optional so a
 * half-written or older archive degrades to zeros/empties rather than throwing. */
type IterationArchive = {
  iteration?: number;
  builder?: { tool_calls?: number; salvaged_tool_calls?: number } | null;
  check?: { ran?: boolean; ok?: boolean; failing_slots?: string[] } | null;
  changes?: { gate_edits?: string[] } | null;
  critic?: { critic_degraded?: boolean } | null;
  unmet_criteria?: string[];
};

/** Read the archived per-iteration summaries in order. A missing archive root
 * (a run that failed before the first `record`) or an unreadable entry yields an
 * empty/short list — the run summary still writes, just without that trajectory
 * detail. */
function read_iteration_archives(workspace: string): IterationArchive[] {
  const root = volley_path(workspace, 'iterations');
  if (!existsSync(root)) return [];
  const dirs = readdirSync(root)
    .filter((dir) => /^\d{3}$/.test(dir))
    .toSorted();
  const archives: IterationArchive[] = [];
  for (const dir of dirs) {
    const path = volley_path(workspace, 'iterations', dir, 'summary.json');
    if (!existsSync(path)) continue;
    try {
      archives.push(JSON.parse(readFileSync(path, 'utf8')) as IterationArchive);
    } catch {
      // A torn/half-written archive is skipped, never fatal to the run summary.
    }
  }
  return archives;
}

function check_trajectory(archives: IterationArchive[]): CheckTrajectoryPoint[] {
  return archives.map((archive, index) => ({
    iteration: typeof archive.iteration === 'number' ? archive.iteration : index + 1,
    ran: archive.check?.ran === true,
    ok: archive.check?.ok === true,
    failing_slots: archive.check?.failing_slots ?? [],
  }));
}

/** The run degraded if any archived iteration's critic verdict came from the
 * tool-less fallback. Reads the same on-disk archives as the other
 * comparison metrics, so it grows with the run. */
function any_critic_degraded(archives: IterationArchive[]): boolean {
  return archives.some((archive) => archive.critic?.critic_degraded === true);
}

/** Every gate path the run's builder touched, across all iterations: an edit in
 * iteration 1 that a later iteration reverted still happened, so the run-level
 * answer is the union rather than the last iteration's list. */
function all_gate_edits(archives: IterationArchive[]): string[] {
  const edits = new Set<string>();
  for (const archive of archives) {
    for (const path of archive.changes?.gate_edits ?? []) edits.add(path);
  }
  return [...edits].toSorted();
}

function salvage_stats(archives: IterationArchive[]): SalvageStats {
  let tool_calls = 0;
  let salvaged_tool_calls = 0;
  for (const archive of archives) {
    tool_calls += archive.builder?.tool_calls ?? 0;
    salvaged_tool_calls += archive.builder?.salvaged_tool_calls ?? 0;
  }
  return {
    tool_calls,
    salvaged_tool_calls,
    rate: tool_calls === 0 ? 0 : salvaged_tool_calls / tool_calls,
  };
}

/** Fold the comparison block onto a `RunResult`, reading the per-iteration
 * archive for the check trajectory and salvage aggregate. Pure over its inputs
 * plus the on-disk archive; `write_run_summary` persists the result. */
export function build_run_summary(config: ResolvedConfig, result: RunResult): RunSummary {
  const archives = read_iteration_archives(config.workspace);
  const wall_clock_ms =
    result.completed_at === null
      ? null
      : Date.parse(result.completed_at) - Date.parse(result.started_at);
  return {
    ...result,
    comparison: {
      builder_transport: transport_of(config.builder_provider),
      critic_transport: transport_of(config.critic_provider),
      iterations_to_converge:
        result.status === 'success' ? result.iterations_completed : null,
      wall_clock_ms,
      total_cost_usd: result.total_cost_usd,
      builder_cost_usd: result.builder_cost_usd,
      critic_cost_usd: result.critic_cost_usd,
      final_verdict: result.final_verdict,
      check_trajectory: check_trajectory(archives),
      gate_edits: all_gate_edits(archives),
      unmet_criteria: archives.at(-1)?.unmet_criteria ?? [],
      local_salvage: salvage_stats(archives),
      critic_degraded: any_critic_degraded(archives),
    },
  };
}

/** Write the enriched summary to `.volley/summary.json` (the projection the
 * examples' comparison is read from). */
export function write_run_summary(config: ResolvedConfig, result: RunResult): void {
  writeFileSync(
    volley_path(config.workspace, 'summary.json'),
    `${JSON.stringify(build_run_summary(config, result), null, 2)}\n`,
  );
}
