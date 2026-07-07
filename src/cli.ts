#!/usr/bin/env node
/**
 * CLI entry point (spec §5): cac argv parsing, dispatch, exit-code mapping.
 * Human progress goes to stderr; stdout carries machine output only.
 */
import { spawnSync } from 'node:child_process';
import { cac } from 'cac';
import {
  DEFAULT_CHECK,
  load_config_file,
  resolve_config,
} from './config.js';
import { resolve_check_runner } from './check/detect.js';
import { exit_code_for_error, exit_code_for_status, EXIT_CONFIG_ERROR, EXIT_SUCCESS } from './exit_codes.js';
import { load_resume_state } from './iteration.js';
import { run_volley } from './orchestrator.js';
import { colors_enabled } from './render/format.js';
import { create_renderer } from './render/renderer.js';
import type { Renderer, RenderMode } from './render/renderer.js';
import { config_error, error_kind } from './types.js';
import type {
  BuilderPermissionMode,
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
  criticModel?: string;
  criticProvider?: string;
  builderPermissionMode?: string;
  critic?: string;
  maxIterations?: number;
  maxCostUsd?: number;
  git?: boolean;
  dryRun?: boolean;
  config?: string;
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  thinking?: boolean;
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

function merge_flags(base: VolleyConfig, flags: CliFlags): VolleyConfig {
  return {
    ...base,
    ...(flags.prompt !== undefined ? { prompt: flags.prompt } : {}),
    ...(flags.workspace !== undefined ? { workspace: flags.workspace } : {}),
    ...(flags.criteria !== undefined ? { criteria: flags.criteria } : {}),
    ...(flags.check !== undefined ? { check: flags.check } : {}),
    ...(flags.builderModel !== undefined ? { builder_model: flags.builderModel } : {}),
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
    ...(flags.dryRun === true ? { dry_run: true } : {}),
    ...(flags.json === true ? { json: true } : {}),
    ...(flags.verbose === true ? { verbose: true } : {}),
    ...(flags.quiet === true ? { quiet: true } : {}),
    ...(flags.thinking === false ? { show_thinking: false } : {}),
  };
}

/** `--dry-run`: validate config and, when checkride is the resolved check,
 * run `checkride doctor` before any model spend (spec §5). */
function dry_run(config: ResolvedConfig, renderer: Renderer): number {
  renderer.info(`dry run: config valid (run ${config.run_id})`);
  renderer.info(`workspace: ${config.workspace}`);
  renderer.info(`check: ${config.check} (resolved: ${config.check_resolved})`);
  renderer.info(`critic: ${config.critic_preset}${config.critic_prompt_path !== null ? ` (${config.critic_prompt_path})` : ''}`);
  renderer.info(`critic model: ${config.critic_model} (provider: ${config.critic_provider})`);
  if (config.check_resolved === 'checkride') {
    const doctor = spawnSync('pnpm', ['exec', 'checkride', 'doctor'], {
      cwd: config.workspace,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    if (doctor.error !== undefined || doctor.status !== 0) {
      renderer.error('checkride doctor failed; fix the workspace check pipeline before running');
      return EXIT_CONFIG_ERROR;
    }
    renderer.info('checkride doctor: ok');
  }
  return EXIT_SUCCESS;
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
    .option('--critic-model <model>', 'Critic model')
    .option('--critic-provider <name>', 'claude_cli | ollama | lmstudio (default: claude_cli)')
    .option('--builder-permission-mode <mode>', 'acceptEdits | bypassPermissions')
    .option('--critic <critic>', 'reviewer | optimizer | researcher | path to prompt file')
    .option('--max-iterations <n>', 'Iteration cap')
    .option('--max-cost-usd <usd>', 'Hard USD ceiling, enforced in the loop guard')
    .option('--git', 'Auto-commit after each phase (workspace must be a git repo)')
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
      if (merged.dry_run === true) {
        exit_code = dry_run(config, renderer);
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
      renderer.info(
        `resuming run ${run_id} at iteration ${String(resume.iterations_completed + 1)}`,
      );
      const result = await run_volley(config, { renderer }, resume.state);
      exit_code = emit_result(config, result, renderer);
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

const code = await main(process.argv);
process.exitCode = code;
