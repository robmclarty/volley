#!/usr/bin/env node
/**
 * CLI entry point (spec §5): cac argv parsing, dispatch, exit-code mapping.
 * Human progress goes to stderr; stdout carries machine output only.
 */
import { join } from 'node:path';
import { cac } from 'cac';
import {
  DEFAULT_CHECK,
  DEFAULT_SANDBOX_IMAGE,
  load_config_file,
  resolve_config,
} from './config.js';
import { resolve_check_runner } from './check/detect.js';
import { exit_code_for_error, exit_code_for_status, EXIT_SUCCESS } from './exit_codes.js';
import { load_resume_state } from './iteration.js';
import { EXIT_MATRIX_INCOMPLETE, parse_model_list, run_matrix } from './matrix.js';
import { run_volley } from './orchestrator.js';
import { preflight } from './preflight.js';
import { colors_enabled } from './render/format.js';
import { create_renderer } from './render/renderer.js';
import type { Renderer, RenderMode } from './render/renderer.js';
import { config_error, error_kind } from './types.js';
import type {
  BuilderPermissionMode,
  BuilderProvider,
  CriticProvider,
  ResolvedConfig,
  RunResult,
  VolleyConfig,
} from './types.js';

type CliFlags = {
  prompt?: string;
  workspace?: string;
  criteria?: string;
  check?: string;
  builderModel?: string;
  builderProvider?: string;
  builderMaxSteps?: number;
  allowUnsandboxedBuilder?: boolean;
  criticModel?: string;
  criticProvider?: string;
  builderPermissionMode?: string;
  critic?: string;
  maxIterations?: number;
  maxCostUsd?: number;
  git?: boolean;
  worktree?: boolean;
  discardWorktree?: boolean;
  sandboxImage?: string;
  dryRun?: boolean;
  config?: string;
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  thinking?: boolean;
};

type MatrixFlags = {
  config?: string;
  builders?: string;
  critics?: string;
  workspace?: string;
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
};

function render_mode(config: ResolvedConfig): RenderMode {
  if (config.json) return 'json';
  if (config.quiet) return 'quiet';
  if (config.verbose) return 'verbose';
  return 'default';
}

function make_renderer(config: ResolvedConfig): Renderer {
  return create_renderer({
    mode: render_mode(config),
    show_thinking: config.show_thinking,
    color: colors_enabled(),
    max_cost_usd: config.max_cost_usd,
  });
}

function warn_api_key_meter(renderer: Renderer): void {
  if (process.env['ANTHROPIC_API_KEY'] !== undefined) {
    renderer.warn(
      'ANTHROPIC_API_KEY is set: the claude CLI will bill this run against the API key, not a subscription. Know which meter you are on.',
    );
  }
}

/** One loud warning when a local builder is about to run *uncontained* on the
 * host via the opt-out (D11 → B′/D5). Config resolution has already refused this
 * unless volley is contained or the opt-out is set, so reaching here with the
 * opt-out active means the operator accepted the uncontained risk. */
export function warn_unsandboxed_builder(config: ResolvedConfig, renderer: Renderer): void {
  if (config.builder_provider !== 'claude_cli' && config.allow_unsandboxed_builder) {
    renderer.warn(
      `UNSANDBOXED BUILDER: '${config.builder_provider}' runs a local model with a real bash ` +
        `(write + exec) directly on this machine in ${config.workspace} — no container isolation. ` +
        `Proceeding because --allow-unsandboxed-builder / VOLLEY_ALLOW_UNSANDBOXED_BUILDER is set; ` +
        `run volley inside its sandbox container (B′-2) for blast-radius containment instead.`,
    );
  }
}

function merge_flags(base: VolleyConfig, flags: CliFlags): VolleyConfig {
  return {
    ...base,
    ...(flags.prompt !== undefined ? { prompt: flags.prompt } : {}),
    ...(flags.workspace !== undefined ? { workspace: flags.workspace } : {}),
    ...(flags.criteria !== undefined ? { criteria: flags.criteria } : {}),
    ...(flags.check !== undefined ? { check: flags.check } : {}),
    ...(flags.builderModel !== undefined ? { builder_model: flags.builderModel } : {}),
    ...(flags.builderProvider !== undefined
      ? { builder_provider: flags.builderProvider as BuilderProvider }
      : {}),
    ...(flags.builderMaxSteps !== undefined
      ? { builder_max_steps: Number(flags.builderMaxSteps) }
      : {}),
    ...(flags.allowUnsandboxedBuilder === true ? { allow_unsandboxed_builder: true } : {}),
    ...(flags.criticModel !== undefined ? { critic_model: flags.criticModel } : {}),
    ...(flags.criticProvider !== undefined
      ? { critic_provider: flags.criticProvider as CriticProvider }
      : {}),
    ...(flags.builderPermissionMode !== undefined
      ? { builder_permission_mode: flags.builderPermissionMode as BuilderPermissionMode }
      : {}),
    ...(flags.critic !== undefined ? { critic: flags.critic } : {}),
    ...(flags.maxIterations !== undefined ? { max_iterations: Number(flags.maxIterations) } : {}),
    ...(flags.maxCostUsd !== undefined ? { max_cost_usd: Number(flags.maxCostUsd) } : {}),
    ...(flags.git === true ? { git_checkpoints: true } : {}),
    ...(flags.worktree === true ? { worktree: true } : {}),
    ...(flags.discardWorktree === true ? { discard_worktree: true } : {}),
    ...(flags.sandboxImage !== undefined ? { sandbox_image: flags.sandboxImage } : {}),
    ...(flags.dryRun === true ? { dry_run: true } : {}),
    ...(flags.json === true ? { json: true } : {}),
    ...(flags.verbose === true ? { verbose: true } : {}),
    ...(flags.quiet === true ? { quiet: true } : {}),
    ...(flags.thinking === false ? { show_thinking: false } : {}),
  };
}

function emit_result(config: ResolvedConfig, result: RunResult, renderer: Renderer): number {
  renderer.final_summary(result);
  if (config.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  return exit_code_for_status(result.status);
}

function report_error(err: unknown): number {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`volley: ${message}\n`);
  if (error_kind(err) === 'phase_error') {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message !== message) {
      process.stderr.write(`  cause: ${cause.message}\n`);
    }
  }
  return exit_code_for_error(err);
}

async function main(argv: string[]): Promise<number> {
  const cli = cac('volley');

  let exit_code = EXIT_SUCCESS;

  cli
    .command('', 'Run the builder/critic loop')
    .option('--prompt <prompt>', 'Task prompt (string or @file)')
    .option('--workspace <path>', 'Workspace directory (must exist and be writable)')
    .option('--criteria <criteria>', 'Acceptance criteria (string or @file)')
    .option('--check <check>', `auto | none | shell command (default: ${DEFAULT_CHECK})`)
    .option('--builder-model <model>', 'Builder model')
    .option('--builder-provider <name>', 'claude_cli | ollama | lmstudio (default: claude_cli)')
    .option('--builder-max-steps <n>', 'Local builder tool-loop step cap per iteration (default: 50)')
    .option('--allow-unsandboxed-builder', 'Permit a local builder to run without a sandbox (real host bash + write)')
    .option('--critic-model <model>', 'Critic model')
    .option('--critic-provider <name>', 'claude_cli | ollama | lmstudio (default: claude_cli)')
    .option('--builder-permission-mode <mode>', 'acceptEdits | bypassPermissions')
    .option('--critic <critic>', 'reviewer | optimizer | researcher | path to prompt file')
    .option('--max-iterations <n>', 'Iteration cap')
    .option('--max-cost-usd <usd>', 'Hard USD ceiling, enforced in the loop guard')
    .option('--git', 'Auto-commit after each phase (workspace must be a git repo)')
    .option('--worktree', 'Isolate the builder run in a per-run git worktree (workspace must be a git repo)')
    .option('--discard-worktree', "Throw a --worktree run's effects away at teardown instead of keeping them on the run branch")
    .option('--sandbox-image <tag>', `Container image for the local-builder sandbox (default: ${DEFAULT_SANDBOX_IMAGE})`)
    .option('--dry-run', 'Validate config (and checkride doctor) without running')
    .option('--config <path>', 'TypeScript config file exporting a VolleyConfig')
    .option('--json', 'Machine mode: final summary JSON on stdout, no streaming')
    .option('--verbose', 'Show full tool inputs/outputs (truncated at 4000 chars)')
    .option('--quiet', 'Only phase transitions, cost updates, and the final summary')
    .option('--no-thinking', 'Hide reasoning chunks (still recorded in the trajectory)')
    .action(async (flags: CliFlags) => {
      const base = flags.config !== undefined ? await load_config_file(flags.config) : ({} as VolleyConfig);
      const merged = merge_flags(base, flags);
      const config = resolve_config(merged);
      config.check_resolved = resolve_check_runner(config.check, config.workspace);
      const renderer = make_renderer(config);
      warn_api_key_meter(renderer);
      warn_unsandboxed_builder(config, renderer);
      if (merged.dry_run === true) {
        exit_code = await preflight(config, renderer, process.env);
        return;
      }
      const result = await run_volley(config, { renderer });
      exit_code = emit_result(config, result, renderer);
    });

  cli
    .command('resume <run_id>', 'Resume a run from its last completed iteration')
    .option('--workspace <path>', 'Workspace containing the .volley run state', {
      default: '.',
    })
    .option('--json', 'Machine mode: final summary JSON on stdout, no streaming')
    .option('--verbose', 'Show full tool inputs/outputs')
    .option('--quiet', 'Only phase transitions, cost updates, and the final summary')
    .option('--no-thinking', 'Hide reasoning chunks')
    .action(async (run_id: string, flags: CliFlags) => {
      const workspace = flags.workspace ?? '.';
      const resume = load_resume_state(workspace, run_id);
      const merged = merge_flags(resume.raw_config, {
        ...(flags.json === true ? { json: true } : {}),
        ...(flags.verbose === true ? { verbose: true } : {}),
        ...(flags.quiet === true ? { quiet: true } : {}),
        ...(flags.thinking === false ? { thinking: false } : {}),
      });
      const config = resolve_config(merged, {
        run_id: resume.run_id,
        started_at: resume.started_at,
      });
      config.check_resolved = resolve_check_runner(config.check, config.workspace);
      if (resume.iterations_completed >= config.max_iterations) {
        throw config_error(
          `run already completed ${String(resume.iterations_completed)} of ${String(config.max_iterations)} iterations`,
        );
      }
      const renderer = make_renderer(config);
      warn_api_key_meter(renderer);
      warn_unsandboxed_builder(config, renderer);
      renderer.info(
        `resuming run ${run_id} at iteration ${String(resume.iterations_completed + 1)}`,
      );
      const result = await run_volley(config, { renderer }, resume.state);
      exit_code = emit_result(config, result, renderer);
    });

  cli
    .command('matrix', 'Sweep builder×critic model combos serially over one config')
    .option('--config <path>', 'Base VolleyConfig (TS/JS): the task, workspace, providers, and caps held fixed')
    .option('--builders <models>', 'Comma-separated builder models to sweep')
    .option('--critics <models>', 'Comma-separated critic models to sweep')
    .option('--workspace <path>', 'Override the base config workspace')
    .option('--json', 'Machine mode: aggregate JSON on stdout, no table')
    .option('--verbose', 'Show full builder/critic streams per combo')
    .option('--quiet', 'Per-combo phase transitions and the final table only')
    .action(async (flags: MatrixFlags) => {
      if (flags.config === undefined) {
        throw config_error('volley matrix requires --config <path> (the base task to sweep)');
      }
      const builders = parse_model_list(flags.builders, '--builders');
      const critics = parse_model_list(flags.critics, '--critics');
      const base = await load_config_file(flags.config);
      const merged = merge_flags(base, {
        ...(flags.workspace !== undefined ? { workspace: flags.workspace } : {}),
        ...(flags.json === true ? { json: true } : {}),
        ...(flags.verbose === true ? { verbose: true } : {}),
        ...(flags.quiet === true ? { quiet: true } : {}),
      });
      // Resolve once with the forced throw-away worktree (D11) to validate the
      // git repo, providers, and task up front — before any combo spends — and to
      // build the renderer and locate the workspace-level `.volley-matrix/`
      // output. Matches what `default_run_combo` resolves per seat.
      const base_config = resolve_config({ ...merged, worktree: true, discard_worktree: true });
      const renderer = make_renderer(base_config);
      warn_api_key_meter(renderer);
      warn_unsandboxed_builder(base_config, renderer);
      const outcome = await run_matrix({
        base: merged,
        builders,
        critics,
        matrix_dir: join(base_config.workspace, '.volley-matrix'),
        renderer,
      });
      if (base_config.json) {
        process.stdout.write(`${JSON.stringify({ combos: outcome.rows }, null, 2)}\n`);
      }
      exit_code = outcome.ok ? EXIT_SUCCESS : EXIT_MATRIX_INCOMPLETE;
    });

  cli.help();
  cli.version('0.2.0');

  try {
    cli.parse(argv, { run: false });
    await cli.runMatchedCommand();
  } catch (err) {
    return report_error(err);
  }
  return exit_code;
}

// Guard the entry so importing this module (e.g. from tests, to exercise the
// exported warn helpers) does not run the CLI. `import.meta.main` is true only
// when this file is the process entry point (symlink-safe; Node ≥ 24).
if (import.meta.main) {
  const code = await main(process.argv);
  process.exitCode = code;
}
