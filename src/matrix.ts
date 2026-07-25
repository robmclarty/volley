/**
 * `volley matrix` (v0.4.1, D6/D11): sweep a set of builder×critic *model*
 * combinations serially over one otherwise-fixed config, then aggregate each
 * run's `comparison` block into a single table. A subcommand — not a bash
 * wrapper around `docker run` — so it reuses `resolve_config`, the forced
 * per-combo worktree reset (D11), and the enriched summary writer instead of
 * reimplementing them.
 *
 * Execution is serial by design (D6): the local providers share one GPU, so
 * parallel combos would thrash the Ollama model loader. Each combo forces
 * `--worktree --discard-worktree` for a clean per-combo reset (D11): a sweep
 * wants verdicts, not effects, so every seat's work is thrown away with its
 * branch — never salvaged onto one, never squash-merged onto the operator's
 * branch (D13). Each combo's `summary.json` is persisted under
 * `.volley-matrix/<builder>__<critic>/` before the next combo overwrites
 * `.volley/summary.json`.
 *
 * Sweep-level exit semantics (D11): a combo that *runs* — even to a non-success
 * status — is a *result*, shown in the table; the sweep only "breaks" (nonzero)
 * when a combo yields no recoverable summary at all.
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
import type { RunStatus, VolleyConfig } from './types.js';
import { volley_path } from './workspace.js';

/** The sweep's nonzero exit: at least one combo produced no summary at all
 * (D11). Distinct from a combo that merely did not converge — that is still a
 * result row and the sweep exits 0. Kept matrix-local (not a phase exit code)
 * so the existing exit-code semantics are untouched (C4). */
export const EXIT_MATRIX_INCOMPLETE = 1;

/** One builder×critic model pairing in the cross product. */
export type MatrixCombo = { builder: string; critic: string };

/** One aggregated table row, sourced from a combo's `comparison` block — or the
 * sweep-break marker (`status: 'broke'`) when the combo produced no summary. */
export type MatrixRow = {
  builder: string;
  critic: string;
  status: RunStatus | 'broke';
  iterations_to_converge: number | null;
  wall_clock_ms: number | null;
  salvage_rate: number | null;
  critic_degraded: boolean;
  error: string | null;
};

export type MatrixOutcome = { rows: MatrixRow[]; ok: boolean };

/** Runs one combo and returns its enriched summary. Injected in tests so the
 * cross product, persistence, and table can be exercised with stubbed runs. */
export type ComboRunner = (
  base: VolleyConfig,
  combo: MatrixCombo,
  renderer: Renderer,
) => Promise<RunSummary>;

export type RunMatrixOptions = {
  base: VolleyConfig;
  builders: string[];
  critics: string[];
  matrix_dir: string;
  renderer: Renderer;
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

/** The config one seat runs under: the base task with this combo's models and a
 * forced throw-away worktree (D11) — `--worktree` isolates the seat's effects and
 * `--discard-worktree` throws them away at teardown, so a sweep of N seats leaves
 * neither N branches behind nor N squash commits on the operator's branch (D13). */
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
 * `summary.json` the orchestrator wrote so the combo is still a result row;
 * rethrow only when nothing is recoverable — then the sweep breaks. */
export const default_run_combo: ComboRunner = async (base, combo, renderer) => {
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
 * the signal `default_run_combo` uses to tell a merely-errored combo (summary
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

/** Run the builder×critic cross product serially, persisting each combo's
 * summary and aggregating the `comparison` blocks into one table (D11). */
export async function run_matrix(options: RunMatrixOptions): Promise<MatrixOutcome> {
  const { base, matrix_dir, renderer } = options;
  const run_combo = options.run_combo ?? default_run_combo;
  const combos: MatrixCombo[] = [];
  for (const builder of options.builders) {
    for (const critic of options.critics) {
      combos.push({ builder, critic });
    }
  }

  const rows: MatrixRow[] = [];
  let ok = true;
  let index = 0;
  for (const combo of combos) {
    index += 1;
    const tag = `matrix [${String(index)}/${String(combos.length)}]`;
    renderer.info(`${tag}: builder=${combo.builder} critic=${combo.critic}`);
    try {
      const summary = await run_combo(base, combo, renderer);
      persist_combo_summary(matrix_dir, combo, summary);
      const row = result_row(combo, summary);
      rows.push(row);
      renderer.info(`${tag}: ${combo.builder} × ${combo.critic} → ${row.status}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rows.push(broke_row(combo, message));
      ok = false;
      renderer.warn(`${tag}: ${combo.builder} × ${combo.critic} produced no summary: ${message}`);
    }
  }

  renderer.info(render_matrix_table(rows));
  return { rows, ok };
}

/** Filesystem-safe slug for a model name in a `.volley-matrix/` path (model
 * ids carry `:` and `/`, e.g. `qwen3.6:latest`). */
function slug(model: string): string {
  return model.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function persist_combo_summary(matrix_dir: string, combo: MatrixCombo, summary: RunSummary): void {
  const dir = join(matrix_dir, `${slug(combo.builder)}__${slug(combo.critic)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

function result_row(combo: MatrixCombo, summary: RunSummary): MatrixRow {
  const c = summary.comparison;
  return {
    builder: combo.builder,
    critic: combo.critic,
    status: summary.status,
    iterations_to_converge: c.iterations_to_converge,
    wall_clock_ms: c.wall_clock_ms,
    salvage_rate: c.local_salvage.rate,
    critic_degraded: c.critic_degraded,
    error: null,
  };
}

function broke_row(combo: MatrixCombo, message: string): MatrixRow {
  return {
    builder: combo.builder,
    critic: combo.critic,
    status: 'broke',
    iterations_to_converge: null,
    wall_clock_ms: null,
    salvage_rate: null,
    critic_degraded: false,
    error: message,
  };
}

const MATRIX_COLUMNS = [
  'builder',
  'critic',
  'status',
  'iters',
  'wall',
  'salvage',
  'degraded',
] as const;

function format_wall(ms: number | null): string {
  return ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`;
}

function format_rate(rate: number | null): string {
  return rate === null ? '—' : `${String(Math.round(rate * 100))}%`;
}

function cell_values(row: MatrixRow): string[] {
  return [
    row.builder,
    row.critic,
    row.status,
    row.iterations_to_converge === null ? '—' : String(row.iterations_to_converge),
    format_wall(row.wall_clock_ms),
    format_rate(row.salvage_rate),
    row.status === 'broke' ? '—' : row.critic_degraded ? 'yes' : 'no',
  ];
}

/** Render the aggregate table as a padded, self-aligning block (stderr, C3).
 * Sourced entirely from the rows' `comparison`-derived fields (D11). */
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
