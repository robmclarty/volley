/**
 * `volley matrix` (v0.4.1): sweep a set of builder×critic *model*
 * combinations serially over one otherwise-fixed config, then aggregate every
 * run's `comparison` block into a single table. A subcommand — not a bash
 * wrapper around `docker run` — so it reuses `resolve_config`, the forced
 * per-combo worktree reset, and the enriched summary writer instead of
 * reimplementing them.
 *
 * Execution is serial by design: the local providers share one GPU, so
 * parallel combos would thrash the Ollama model loader. Each combo forces
 * `--worktree --discard-worktree` for a clean per-combo reset: a sweep
 * wants verdicts, not effects, so every seat's work is thrown away with its
 * branch — never salvaged onto one, never squash-merged onto the operator's
 * branch.
 *
 * **A seat is measured over `repeat` attempts, not one.** A single run answers
 * "did this pairing converge that time", which is the only question n=1 can
 * answer honestly: local runs are stochastic, so one sample supports a *hard*
 * failure (`research/v3-comparison-finding.md` reproduced the qwen3.6 critic
 * death 2/2) and nothing else — not iterations-to-converge, not wall clock. With
 * `--repeat` the row reports a pass *rate* and averages over the attempts behind
 * it, and every attempt's own summary is kept.
 *
 * **A row says why a seat fell off**, not just that it did. `budget_exhausted`
 * is a status, not a diagnosis; the failing check slots, the criteria still
 * unmet, a cost cap, or a gate edit are. Each is read from the attempt's
 * `comparison` block and folded into one `reason`.
 *
 * Sweep-level exit semantics: an attempt that *runs* — even to a
 * non-success status — is a *result*, shown in the table; the sweep only
 * "breaks" (nonzero) when an attempt yields no recoverable summary at all.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve_check_runner } from './check/detect.js';
import { resolve_config } from './config.js';
import { run_volley } from './orchestrator.js';
import type { Renderer } from './render/renderer.js';
import { build_run_summary } from './summary.js';
import type { RunSummary } from './summary.js';
import { config_error } from './types.js';
import type { RunStatus, Verdict, VolleyConfig } from './types.js';
import { volley_path } from './workspace.js';

/** The sweep's nonzero exit: at least one attempt produced no summary at all.
 * Distinct from an attempt that merely did not converge — that is still a
 * result and the sweep exits 0. Kept matrix-local (not a phase exit code) so the
 * existing exit-code semantics are untouched. */
export const EXIT_MATRIX_INCOMPLETE = 1;

/** How many times each seat runs when `--repeat` is not given. One attempt is
 * enough to smoke-test a pairing and is what a quick sweep wants; anything that
 * compares seats should raise it. */
const DEFAULT_REPEAT = 1;

/** One builder×critic model pairing in the cross product. */
export type MatrixCombo = { builder: string; critic: string };

/** One run of one seat: what the sweep reads back from that attempt's summary.
 * `status: 'broke'` means the attempt produced no summary at all — the only
 * outcome that fails the sweep. */
export type MatrixAttempt = {
  attempt: number;
  status: RunStatus | 'broke';
  converged: boolean;
  iterations_to_converge: number | null;
  wall_clock_ms: number | null;
  total_cost_usd: number | null;
  final_verdict: Verdict | null;
  /** The check slots failing on the last iteration that ran one. */
  failing_slots: string[];
  /** What the critic still judged unmet when the run stopped. */
  unmet_criteria: string[];
  gate_edits: string[];
  critic_degraded: boolean;
  tool_calls: number;
  salvaged_tool_calls: number;
  error: string | null;
  /** Why this attempt did not converge, in a few words; null when it did. */
  reason: string | null;
};

/** One table row: a seat, aggregated over its attempts, with every attempt kept
 * for `--json` consumers that want the spread rather than the average. */
export type MatrixRow = {
  builder: string;
  critic: string;
  /** Attempts made, and how many converged: the row's headline. */
  runs: number;
  converged: number;
  /** Mean over *converged* attempts — averaging in a run that never converged
   * would report an iteration count that never happened. Null when none did. */
  mean_iterations: number | null;
  /** Mean over every attempt that reported a wall clock, converged or not: a
   * seat that burns twenty minutes before giving up costs you that either way. */
  mean_wall_clock_ms: number | null;
  mean_cost_usd: number | null;
  /** Salvaged tool calls over total tool calls across all attempts — a ratio of
   * totals, not a mean of ratios, so a busy attempt weighs more than a quiet one. */
  salvage_rate: number | null;
  /** True when *any* attempt's critic degraded to the tool-less rung. */
  critic_degraded: boolean;
  /** Every gate path any attempt's builder edited (`src/changes.ts`). */
  gate_edits: string[];
  /** The most recent non-converged attempt's reason; null when all converged. */
  reason: string | null;
  attempts: MatrixAttempt[];
};

export type MatrixOutcome = { rows: MatrixRow[]; ok: boolean };

/** Runs one attempt at one seat and returns its enriched summary. Injected in
 * tests so the cross product, repeats, persistence, and table can be exercised
 * with stubbed runs. */
export type ComboRunner = (
  base: VolleyConfig,
  combo: MatrixCombo,
  renderer: Renderer,
  attempt: number,
) => Promise<RunSummary>;

export type RunMatrixOptions = {
  base: VolleyConfig;
  builders: string[];
  critics: string[];
  matrix_dir: string;
  renderer: Renderer;
  repeat?: number;
  run_combo?: ComboRunner;
};

/** Split a `--builders`/`--critics` value into a trimmed, non-empty model
 * list. Empty or all-whitespace is a config error, refused before any spend. */
export function parse_model_list(value: string | undefined, flag: string): string[] {
  const items = (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.length === 0) {
    throw config_error(`${flag} must be a comma-separated list of at least one model`);
  }
  return items;
}

/** Validate `--repeat`: attempts per seat, a positive integer. Refused before
 * any spend, like every other cap. */
export function parse_repeat(value: number | string | undefined): number {
  if (value === undefined) return DEFAULT_REPEAT;
  const repeat = Number(value);
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw config_error(`--repeat must be a positive integer; got: ${String(value)}`);
  }
  return repeat;
}

/** The config one seat runs under: the base task with this combo's models and a
 * forced throw-away worktree — `--worktree` isolates the seat's effects and
 * `--discard-worktree` throws them away at teardown, so a sweep of N seats leaves
 * neither N branches behind nor N squash commits on the operator's branch. */
export function combo_config(base: VolleyConfig, combo: MatrixCombo): VolleyConfig {
  return {
    ...base,
    builder_model: combo.builder,
    critic_model: combo.critic,
    worktree: true,
    discard_worktree: true,
  };
}

/** The default combo runner: resolve this seat's config, run the loop, and fold
 * on the comparison block.
 * If the run throws (an unsalvageable phase failure), recover the best-effort
 * `summary.json` the orchestrator wrote so the attempt is still a result;
 * rethrow only when nothing is recoverable — then the sweep breaks. */
const default_run_combo: ComboRunner = async (base, combo, renderer) => {
  const config = resolve_config(combo_config(base, combo));
  config.check_resolved = resolve_check_runner(config.check, config.workspace);
  try {
    const result = await run_volley(config, { renderer });
    return build_run_summary(config, result);
  } catch (err) {
    const recovered = read_run_summary(config.workspace);
    if (recovered === null) throw err;
    return recovered;
  }
};

/** Read a run's `.volley/summary.json`, or null if it is missing/unparseable —
 * the signal `default_run_combo` uses to tell a merely-errored attempt (summary
 * on disk) from a truly broken one (nothing to recover). */
function read_run_summary(workspace: string): RunSummary | null {
  const path = volley_path(workspace, 'summary.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RunSummary;
  } catch {
    return null;
  }
}

/** How much of a criterion or an error a `reason` carries before it is cut —
 * enough to recognise which one, short enough for a table cell. */
const REASON_MAX = 44;

function clip(text: string): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  return flat.length > REASON_MAX ? `${flat.slice(0, REASON_MAX - 1)}…` : flat;
}

/** The check slots failing on the last iteration that ran a check. */
function last_failing_slots(summary: RunSummary): string[] {
  const ran = summary.comparison.check_trajectory.filter((point) => point.ran);
  return ran.at(-1)?.failing_slots ?? [];
}

/**
 * Why this attempt did not converge, in a few words — the column that turns a
 * sweep from "which seats passed" into "where each one falls off".
 *
 * Ordered by how *specific* the answer is: a halt names itself, a failing check
 * names its slots, and a run that was gated only by the critic names what it
 * still judged unmet. `budget_exhausted` with nothing else to say means the loop
 * ran out of iterations while the critic kept asking for changes it did not
 * enumerate — worth seeing as exactly that.
 */
export function failure_reason(summary: RunSummary): string | null {
  if (summary.status === 'success') return null;
  if (summary.status === 'cost_cap_reached') return 'cost cap';
  if (summary.status === 'interrupted') return 'interrupted';
  if (summary.status === 'gate_edit_blocked') {
    return clip(`gate edit: ${summary.comparison.gate_edits.join(', ')}`);
  }
  const failing = last_failing_slots(summary);
  if (failing.length > 0) return clip(`check: ${failing.join(', ')}`);
  const unmet = summary.comparison.unmet_criteria;
  if (unmet.length === 1) return clip(`unmet: ${unmet[0] ?? ''}`);
  if (unmet.length > 1) return clip(`unmet: ${String(unmet.length)} criteria`);
  return summary.status === 'error' ? 'run error' : String(summary.status);
}

function attempt_from_summary(attempt: number, summary: RunSummary): MatrixAttempt {
  const c = summary.comparison;
  return {
    attempt,
    status: summary.status,
    converged: summary.status === 'success',
    iterations_to_converge: c.iterations_to_converge,
    wall_clock_ms: c.wall_clock_ms,
    total_cost_usd: c.total_cost_usd,
    final_verdict: c.final_verdict,
    failing_slots: last_failing_slots(summary),
    unmet_criteria: c.unmet_criteria,
    gate_edits: c.gate_edits,
    critic_degraded: c.critic_degraded,
    tool_calls: c.local_salvage.tool_calls,
    salvaged_tool_calls: c.local_salvage.salvaged_tool_calls,
    error: null,
    reason: failure_reason(summary),
  };
}

function broke_attempt(attempt: number, message: string): MatrixAttempt {
  return {
    attempt,
    status: 'broke',
    converged: false,
    iterations_to_converge: null,
    wall_clock_ms: null,
    total_cost_usd: null,
    final_verdict: null,
    failing_slots: [],
    unmet_criteria: [],
    gate_edits: [],
    critic_degraded: false,
    tool_calls: 0,
    salvaged_tool_calls: 0,
    error: message,
    reason: clip(`broke: ${message}`),
  };
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function defined_numbers(values: Array<number | null>): number[] {
  return values.filter((value): value is number => value !== null);
}

/** Fold a seat's attempts into one row. Every aggregate names the population it
 * is over (see `MatrixRow`), because averaging the wrong set is how a sweep
 * reports a number nothing actually did. */
function aggregate_row(combo: MatrixCombo, attempts: MatrixAttempt[]): MatrixRow {
  const converged = attempts.filter((attempt) => attempt.converged);
  const tool_calls = attempts.reduce((total, attempt) => total + attempt.tool_calls, 0);
  const salvaged = attempts.reduce((total, attempt) => total + attempt.salvaged_tool_calls, 0);
  const gate_edits = new Set(attempts.flatMap((attempt) => attempt.gate_edits));
  return {
    builder: combo.builder,
    critic: combo.critic,
    runs: attempts.length,
    converged: converged.length,
    mean_iterations: mean(defined_numbers(converged.map((a) => a.iterations_to_converge))),
    mean_wall_clock_ms: mean(defined_numbers(attempts.map((a) => a.wall_clock_ms))),
    mean_cost_usd: mean(defined_numbers(attempts.map((a) => a.total_cost_usd))),
    salvage_rate: tool_calls === 0 ? null : salvaged / tool_calls,
    critic_degraded: attempts.some((attempt) => attempt.critic_degraded),
    gate_edits: [...gate_edits].toSorted(),
    reason: attempts.findLast((attempt) => !attempt.converged)?.reason ?? null,
    attempts,
  };
}

function cross_product(builders: string[], critics: string[]): MatrixCombo[] {
  return builders.flatMap((builder) => critics.map((critic) => ({ builder, critic })));
}

function combo_dir(matrix_dir: string, combo: MatrixCombo): string {
  return join(matrix_dir, `${slug(combo.builder)}__${slug(combo.critic)}`);
}

/** Filesystem-safe slug for a model name in a `.volley-matrix/` path (model
 * ids carry `:` and `/`, e.g. `qwen3.6:latest`). */
function slug(model: string): string {
  return model.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** One attempt's run state, kept before the next attempt overwrites
 * `.volley/summary.json`. Every attempt gets its own `run-NN/` so a repeated
 * seat keeps all of its evidence, not just the last run's. */
function persist_attempt(
  matrix_dir: string,
  combo: MatrixCombo,
  attempt: number,
  summary: RunSummary,
): void {
  const dir = join(combo_dir(matrix_dir, combo), `run-${String(attempt).padStart(2, '0')}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

/** The whole sweep as one machine-readable document, written where the run state
 * is — a long ladder sweep is worth re-reading without re-running. */
function persist_matrix(matrix_dir: string, rows: MatrixRow[]): string {
  mkdirSync(matrix_dir, { recursive: true });
  const path = join(matrix_dir, 'matrix.json');
  writeFileSync(path, `${JSON.stringify({ combos: rows }, null, 2)}\n`);
  return path;
}

/** Run one seat `repeat` times, serially, keeping each attempt's run state. */
async function run_combo_attempts(
  options: Required<Pick<RunMatrixOptions, 'base' | 'matrix_dir' | 'renderer'>> & {
    combo: MatrixCombo;
    repeat: number;
    run_combo: ComboRunner;
    tag: string;
  },
): Promise<{ attempts: MatrixAttempt[]; ok: boolean }> {
  const { combo, renderer, repeat, tag } = options;
  const attempts: MatrixAttempt[] = [];
  let ok = true;
  for (let attempt = 1; attempt <= repeat; attempt += 1) {
    const label = repeat === 1 ? tag : `${tag} run ${String(attempt)}/${String(repeat)}`;
    renderer.info(`${label}: builder=${combo.builder} critic=${combo.critic}`);
    try {
      const summary = await options.run_combo(options.base, combo, renderer, attempt);
      persist_attempt(options.matrix_dir, combo, attempt, summary);
      const result = attempt_from_summary(attempt, summary);
      attempts.push(result);
      renderer.info(`${label}: → ${result.status}${result.reason === null ? '' : ` (${result.reason})`}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      attempts.push(broke_attempt(attempt, message));
      ok = false;
      renderer.warn(`${label}: produced no summary: ${message}`);
    }
  }
  return { attempts, ok };
}

/** Run the builder×critic cross product serially — `repeat` attempts per seat —
 * persisting every attempt's summary and aggregating them into one table. */
export async function run_matrix(options: RunMatrixOptions): Promise<MatrixOutcome> {
  const { base, matrix_dir, renderer } = options;
  const run_combo = options.run_combo ?? default_run_combo;
  const repeat = options.repeat ?? DEFAULT_REPEAT;
  const combos = cross_product(options.builders, options.critics);
  renderer.info(
    `matrix: ${String(combos.length)} seat(s) × ${String(repeat)} run(s) = ` +
      `${String(combos.length * repeat)} run(s), serially`,
  );

  const rows: MatrixRow[] = [];
  let ok = true;
  let index = 0;
  for (const combo of combos) {
    index += 1;
    const outcome = await run_combo_attempts({
      base,
      matrix_dir,
      renderer,
      combo,
      repeat,
      run_combo,
      tag: `matrix [${String(index)}/${String(combos.length)}]`,
    });
    ok = ok && outcome.ok;
    rows.push(aggregate_row(combo, outcome.attempts));
  }

  renderer.info(render_matrix_table(rows));
  renderer.info(`matrix: wrote ${persist_matrix(matrix_dir, rows)}`);
  return { rows, ok };
}

const MATRIX_COLUMNS = [
  'builder',
  'critic',
  'pass',
  'iters',
  'wall',
  'cost',
  'salvage',
  'flags',
  'why',
] as const;

function format_wall(ms: number | null): string {
  return ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`;
}

function format_rate(rate: number | null): string {
  return rate === null ? '—' : `${String(Math.round(rate * 100))}%`;
}

function format_cost(usd: number | null): string {
  return usd === null ? '—' : `$${usd.toFixed(2)}`;
}

function format_iterations(iterations: number | null): string {
  return iterations === null ? '—' : iterations.toFixed(1);
}

/** The two facts that qualify a pass rather than explain a failure, so they do
 * not have to compete with `why` for the same cell. */
function format_flags(row: MatrixRow): string {
  const flags = [
    row.critic_degraded ? 'deg' : null,
    row.gate_edits.length > 0 ? 'gate' : null,
  ].filter((flag): flag is string => flag !== null);
  return flags.length === 0 ? '—' : flags.join(',');
}

function cell_values(row: MatrixRow): string[] {
  return [
    row.builder,
    row.critic,
    `${String(row.converged)}/${String(row.runs)}`,
    format_iterations(row.mean_iterations),
    format_wall(row.mean_wall_clock_ms),
    format_cost(row.mean_cost_usd),
    format_rate(row.salvage_rate),
    format_flags(row),
    row.reason ?? '—',
  ];
}

/** Render the aggregate table as a padded, self-aligning block (stderr).
 * Sourced entirely from the rows' `comparison`-derived fields. */
export function render_matrix_table(rows: MatrixRow[]): string {
  const header: string[] = [...MATRIX_COLUMNS];
  const body = rows.map(cell_values);
  const widths = header.map((title, col) =>
    Math.max(title.length, ...body.map((cells) => (cells[col] ?? '').length)),
  );
  const render_line = (cells: string[]): string =>
    cells.map((cell, col) => cell.padEnd(widths[col] ?? 0)).join('  ').trimEnd();
  const separator = widths.map((w) => '─'.repeat(w)).join('  ');
  return [render_line(header), separator, ...body.map(render_line)].join('\n');
}
