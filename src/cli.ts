#!/usr/bin/env node
/**
 * CLI entry point: cac argv parsing, dispatch, exit-code mapping.
 * Human progress goes to stderr; stdout carries machine output only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cac } from 'cac';
import type { Command } from 'cac';
import { serve_acp } from 'fascicle/acp';
import { ACP_MAX_ITERATIONS, acp_base_config, acp_serve_config } from './acp.js';
import {
  DEFAULT_CHECK,
  DEFAULT_SANDBOX_IMAGE,
  load_config_file,
  resolve_config,
} from './config.js';
import { resolve_baseline } from './changes.js';
import { exit_code_for_error, exit_code_for_status, EXIT_SUCCESS } from './exit_codes.js';
import { find_run_state, load_resume_state } from './iteration.js';
import { EXIT_MATRIX_INCOMPLETE, parse_model_list, parse_repeat, run_matrix } from './matrix.js';
import { run_critique, run_volley } from './orchestrator.js';
import { preflight } from './preflight.js';
import { colors_enabled, shown } from './render/format.js';
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
import { default_state_root, state_path } from './workspace.js';

/** One help string for every command that takes a state root. */
const STATE_DIR_HELP =
  "Keep each run's state under <path>/<run id>/ (default: $XDG_STATE_HOME/volley, else ~/.local/state/volley)";

type CliFlags = {
  prompt?: string;
  workspace?: string;
  criteria?: string;
  check?: string;
  builderModel?: string;
  builderProvider?: string;
  builderUrl?: string;
  builderMaxSteps?: number;
  builderMaxToolCalls?: number;
  allowUnsandboxedBuilder?: boolean;
  criticModel?: string;
  criticProvider?: string;
  criticUrl?: string;
  builderPermissionMode?: string;
  critic?: string;
  maxIterations?: number;
  maxCostUsd?: number;
  git?: boolean;
  worktree?: boolean;
  discardWorktree?: boolean;
  gatePaths?: string;
  failOnGateEdit?: boolean;
  sandboxImage?: string;
  stateDir?: string;
  /** A number when cac coerced a numeric-looking value (`0042` arrives as 42). */
  runId?: string | number;
  dryRun?: boolean;
  trustConfig?: boolean;
  config?: string;
  /** A number when cac coerced an all-digit revision, as it does `runId`. */
  baseline?: string | number;
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
  repeat?: number;
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
};

/**
 * volley's own version for `--version`, read from the manifest rather than
 * repeated here — a literal drifts silently, since `pnpm version` bumps only
 * `package.json` (this one sat at `0.2.0` through three releases).
 *
 * Walks up from this module to the nearest `package.json`, the same shape
 * `presets_dir()` uses to find its files: the manifest sits directly above both
 * `src/` (under tsx) and `dist/` (the built bin, and the published package), so
 * one walk serves every entry path. Never throws — an unreadable manifest
 * reports `unknown` rather than failing every command over a version string.
 */
export function package_version(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const version = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown })
          .version;
        if (typeof version === 'string') return version;
      } catch {
        // A torn or unreadable manifest is not worth failing a run over.
      }
    }
    dir = dirname(dir);
  }
  return 'unknown';
}

/** Split a comma-separated `--gate-paths` value into globs. An all-empty value
 * yields an empty list — "nothing is the gate", which turns the report off. */
function parse_glob_list(value: string): string[] {
  return value
    .split(',')
    .map((glob) => glob.trim())
    .filter((glob) => glob.length > 0);
}

function render_mode(config: ResolvedConfig): RenderMode {
  if (config.json) return 'json';
  if (config.quiet) return 'quiet';
  if (config.verbose) return 'verbose';
  return 'default';
}

/** `run_id` names the run whose trajectory the verbose hint points at; a
 * sweep passes a placeholder, since each seat has an id of its own. */
function make_renderer(config: ResolvedConfig, run_id: string = config.run_id): Renderer {
  return create_renderer({
    mode: render_mode(config),
    show_thinking: config.show_thinking,
    color: colors_enabled(),
    max_cost_usd: config.max_cost_usd,
    trajectory_path: state_path({ ...config, run_id }, 'trajectory.jsonl'),
  });
}

function warn_api_key_meter(renderer: Renderer): void {
  if (process.env['ANTHROPIC_API_KEY'] !== undefined) {
    renderer.warn(
      'ANTHROPIC_API_KEY is set: the claude CLI will bill this run against the API key, not a subscription. Know which meter you are on.',
    );
  }
}

/** One loud warning when a tool-loop builder is about to run *uncontained* on
 * the host via the opt-out. Config resolution has already refused this
 * unless volley is contained or the opt-out is set, so reaching here with the
 * opt-out active means the operator accepted the uncontained risk. */
export function warn_unsandboxed_builder(config: ResolvedConfig, renderer: Renderer): void {
  if (config.builder_provider !== 'claude_cli' && config.allow_unsandboxed_builder) {
    renderer.warn(
      `UNSANDBOXED BUILDER: '${config.builder_provider}' runs volley's tool loop with a real bash ` +
        `(write + exec) directly on this machine in ${config.workspace} — no container isolation. ` +
        `Proceeding because --allow-unsandboxed-builder / VOLLEY_ALLOW_UNSANDBOXED_BUILDER is set; ` +
        `run volley inside its sandbox container for blast-radius containment instead.`,
    );
  }
}

/** The critic seat's options: its model, provider, and URL. `required` marks
 * the model and provider as having no default, as under `acp`. */
function with_critic_options(command: Command, required = false): Command {
  const model_note = required ? ' (required)' : '';
  const provider_note = required ? 'required' : 'default: claude_cli';
  return command
    .option('--critic-model <model>', `Critic model${model_note}`)
    .option('--critic-provider <name>', `claude_cli | ollama | lmstudio | openrouter (${provider_note})`)
    .option('--critic-url <url>', "Critic's model server base URL, ollama, lmstudio, or openrouter only (default: VOLLEY_OLLAMA_URL / VOLLEY_LMSTUDIO_URL / VOLLEY_OPENROUTER_URL)");
}

/** The seat options, declared once for every command that runs seats: each
 * seat's model, provider, and URL, the tool-loop builder's step cap, and the
 * unsandboxed opt-out. `required` marks each seat's model and provider as
 * having no default, as under `acp`. */
function with_seat_options(command: Command, required = false): Command {
  const model_note = required ? ' (required)' : '';
  const provider_note = required ? 'required' : 'default: claude_cli';
  return with_critic_options(
    command
      .option('--builder-model <model>', `Builder model${model_note}`)
      .option('--builder-provider <name>', `claude_cli | ollama | lmstudio | openrouter (${provider_note})`)
      .option('--builder-url <url>', "Builder's model server base URL, ollama, lmstudio, or openrouter only (default: VOLLEY_OLLAMA_URL / VOLLEY_LMSTUDIO_URL / VOLLEY_OPENROUTER_URL)")
      .option('--builder-max-steps <n>', 'Tool-loop builder step cap per iteration, any provider but claude_cli (default: 50)')
      .option('--builder-max-tool-calls <n>', 'Tool calls a tool-loop builder may make per turn, any provider but claude_cli (default: 1)')
      .option('--allow-unsandboxed-builder', 'Permit a builder other than claude_cli to run without a sandbox (real host bash + write)'),
    required,
  );
}

/** What a critique declares only so that it can refuse each by name, with
 * exit 5: cac would answer an undeclared one with a bare "Unknown option".
 * `resolve_config` refuses all but `--config`, which the command does. */
const CRITIQUE_REFUSED_OPTIONS = [
  '--builder-model <model>',
  '--builder-provider <name>',
  '--builder-url <url>',
  '--builder-max-steps <n>',
  '--builder-max-tool-calls <n>',
  '--builder-permission-mode <mode>',
  '--allow-unsandboxed-builder',
  '--sandbox-image <tag>',
  '--max-iterations <n>',
  '--max-cost-usd <usd>',
  '--git',
  '--worktree',
  '--discard-worktree',
  '--fail-on-gate-edit',
  '--config <path>',
];

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
    ...(flags.builderUrl !== undefined ? { builder_url: flags.builderUrl } : {}),
    ...(flags.builderMaxSteps !== undefined
      ? { builder_max_steps: Number(flags.builderMaxSteps) }
      : {}),
    ...(flags.builderMaxToolCalls !== undefined
      ? { builder_max_tool_calls: Number(flags.builderMaxToolCalls) }
      : {}),
    ...(flags.allowUnsandboxedBuilder === true ? { allow_unsandboxed_builder: true } : {}),
    ...(flags.criticModel !== undefined ? { critic_model: flags.criticModel } : {}),
    ...(flags.criticProvider !== undefined
      ? { critic_provider: flags.criticProvider as CriticProvider }
      : {}),
    ...(flags.criticUrl !== undefined ? { critic_url: flags.criticUrl } : {}),
    ...(flags.builderPermissionMode !== undefined
      ? { builder_permission_mode: flags.builderPermissionMode as BuilderPermissionMode }
      : {}),
    ...(flags.critic !== undefined ? { critic: flags.critic } : {}),
    ...(flags.maxIterations !== undefined ? { max_iterations: Number(flags.maxIterations) } : {}),
    ...(flags.maxCostUsd !== undefined ? { max_cost_usd: Number(flags.maxCostUsd) } : {}),
    ...(flags.git === true ? { git_checkpoints: true } : {}),
    ...(flags.worktree === true ? { worktree: true } : {}),
    ...(flags.discardWorktree === true ? { discard_worktree: true } : {}),
    ...(flags.gatePaths !== undefined ? { gate_paths: parse_glob_list(flags.gatePaths) } : {}),
    ...(flags.failOnGateEdit === true ? { fail_on_gate_edit: true } : {}),
    ...(flags.sandboxImage !== undefined ? { sandbox_image: flags.sandboxImage } : {}),
    ...(flags.stateDir !== undefined ? { state_dir: flags.stateDir } : {}),
    ...(flags.dryRun === true ? { dry_run: true } : {}),
    ...(flags.json === true ? { json: true } : {}),
    ...(flags.verbose === true ? { verbose: true } : {}),
    ...(flags.quiet === true ? { quiet: true } : {}),
    ...(flags.thinking === false ? { show_thinking: false } : {}),
  };
}

/** What a resume is about to run on a config this machine didn't sign, said
 * once before it runs, so `--trust-config` is never a blind yes. Every value
 * came from that config, so each is quoted with its control characters
 * escaped, and can't redraw the line it's warned on. */
function warn_trusted_config(config: ResolvedConfig, renderer: Renderer): void {
  renderer.warn(
    `resuming on a config volley on this machine didn't sign (--trust-config): check ` +
      `${shown(config.check)} (resolved: ${config.check_resolved}), builder ` +
      `${config.builder_provider} ${shown(config.builder_model)} (${config.builder_permission_mode}), ` +
      `critic ${config.critic_provider} ${shown(config.critic_model)}, workspace ${shown(config.workspace)}`,
  );
}

/** A flag's value as typed. cac reads an all-digit value as a number, which
 * drops leading zeros, so a coerced id or revision would silently name another
 * run or commit: refused rather than guessed at. */
function not_a_bare_number(name: string, value: string | number | undefined): string | undefined {
  if (typeof value === 'number') {
    throw config_error(`${name} must not be a bare number (read as ${String(value)})`);
  }
  return value;
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

  const run_command = cli
    .command('', 'Run the builder/critic loop')
    .option('--prompt <prompt>', 'Task prompt (string or @file)')
    .option('--workspace <path>', 'Workspace directory (must exist and be writable)')
    .option('--criteria <criteria>', 'Acceptance criteria (string or @file)')
    .option('--check <check>', `auto | none | shell command (default: ${DEFAULT_CHECK})`);
  with_seat_options(run_command)
    .option('--builder-permission-mode <mode>', 'acceptEdits | bypassPermissions')
    .option('--critic <critic>', 'reviewer | optimizer | researcher | path to prompt file')
    .option('--max-iterations <n>', 'Iteration cap')
    .option('--max-cost-usd <usd>', 'Hard USD ceiling, enforced in the loop guard')
    .option('--git', 'Auto-commit after each phase (workspace must be a git repo)')
    .option('--worktree', 'Isolate the builder run in a per-run git worktree (workspace must be a git repo)')
    .option('--discard-worktree', "Throw a --worktree run's effects away at teardown instead of keeping them on the run branch")
    .option('--gate-paths <globs>', 'Comma-separated globs naming the gate (tests, fixtures, check config); replaces the defaults')
    .option('--fail-on-gate-edit', 'Halt the run if the builder edits a gate path (exit 8) instead of reporting it')
    .option('--sandbox-image <tag>', `Container image for the local-builder sandbox (default: ${DEFAULT_SANDBOX_IMAGE})`)
    .option('--state-dir <path>', STATE_DIR_HELP)
    .option('--run-id <id>', "The run's id, naming its volley/<id> branch (default: a fresh UUID)")
    .option('--dry-run', 'Validate config (and checkride doctor) without running')
    .option('--config <path>', 'TypeScript config file exporting a VolleyConfig')
    .option('--json', 'Machine mode: final summary JSON on stdout, no streaming')
    .option('--verbose', 'Show full tool inputs/outputs (truncated at 4000 chars)')
    .option('--quiet', 'Only phase transitions, cost updates, and the final summary')
    .option('--no-thinking', 'Hide reasoning chunks (still recorded in the trajectory)')
    .action(async (flags: CliFlags) => {
      const base = flags.config !== undefined ? await load_config_file(flags.config) : ({} as VolleyConfig);
      const merged = merge_flags(base, flags);
      const run_id = not_a_bare_number('--run-id', flags.runId);
      const config = resolve_config(merged, run_id !== undefined ? { run_id } : {});
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
    .option('--workspace <path>', "Where a run an older volley started keeps its .volley/ state", {
      default: '.',
    })
    .option('--state-dir <path>', 'State root the run was started under (default: $XDG_STATE_HOME/volley, else ~/.local/state/volley)')
    .option('--trust-config', "Resume a config volley on this machine didn't sign: another machine's, an older volley's, or one you edited. Read it first")
    .option('--json', 'Machine mode: final summary JSON on stdout, no streaming')
    .option('--verbose', 'Show full tool inputs/outputs')
    .option('--quiet', 'Only phase transitions, cost updates, and the final summary')
    .option('--no-thinking', 'Hide reasoning chunks')
    .action(async (run_id: string, flags: CliFlags) => {
      // cac refuses any option this command doesn't declare, so what's left
      // once the lookup flags are taken out is the output flags alone.
      const { workspace = '.', stateDir, trustConfig, ...output } = flags;
      // The run is looked for under the root named here, else the default, and
      // where it's found wins over the recorded root, so a moved root resumes
      // where it now is. A run an older volley kept in .volley/ resumes there.
      const root = stateDir === undefined ? default_state_root(process.env) : resolve(stateDir);
      const state_dir = find_run_state(workspace, run_id, root);
      const resume = load_resume_state(workspace, run_id, state_dir, {
        trust_config: trustConfig === true,
      });
      const merged = merge_flags(resume.raw_config, output);
      const config = resolve_config(merged, {
        run_id: resume.run_id,
        started_at: resume.started_at,
        state_dir,
      });
      if (resume.iterations_completed >= config.max_iterations) {
        throw config_error(
          `run already completed ${String(resume.iterations_completed)} of ${String(config.max_iterations)} iterations`,
        );
      }
      const renderer = make_renderer(config);
      warn_api_key_meter(renderer);
      warn_unsandboxed_builder(config, renderer);
      if (resume.config_signed === false) warn_trusted_config(config, renderer);
      renderer.info(
        `resuming run ${run_id} at iteration ${String(resume.iterations_completed + 1)}`,
      );
      const result = await run_volley(config, { renderer }, resume.state);
      exit_code = emit_result(config, result, renderer);
    });

  const critique_command = cli
    .command('critique', 'Check and critique a change already made, once, with no builder')
    .option('--workspace <path>', 'The repository whose change is reviewed', { default: '.' })
    .option('--baseline <rev>', 'Review everything that differs from this revision, committed or not (default: HEAD)')
    .option('--criteria <criteria>', 'Acceptance criteria (string or @file)')
    .option('--prompt <prompt>', 'The task the change answers, recorded with the run; the critic judges against --criteria')
    .option('--check <check>', `auto | none | shell command (default: ${DEFAULT_CHECK})`);
  with_critic_options(critique_command)
    .option('--critic <critic>', 'reviewer | optimizer | researcher | path to prompt file')
    .option('--gate-paths <globs>', 'Comma-separated globs naming the gate (tests, fixtures, check config); replaces the defaults')
    .option('--state-dir <path>', STATE_DIR_HELP)
    .option('--run-id <id>', "The run's id, naming its state directory (default: a fresh UUID)")
    .option('--dry-run', 'Validate config and the baseline, run checkride doctor, and probe the critic seat, then exit')
    .option('--json', 'Machine mode: final summary JSON on stdout, no streaming')
    .option('--verbose', 'Show full tool inputs/outputs (truncated at 4000 chars)')
    .option('--quiet', 'Only phase transitions, cost updates, and the final summary')
    .option('--no-thinking', 'Hide reasoning chunks (still recorded in the trajectory)');
  for (const refused of CRITIQUE_REFUSED_OPTIONS) {
    critique_command.option(refused, 'Refused: a critique runs no builder and no loop');
  }
  critique_command.action(async (flags: CliFlags) => {
    if (flags.config !== undefined) {
      throw config_error(
        "volley critique refuses --config: a run's config file sets a builder; pass the critique's settings as flags",
      );
    }
    const run_id = not_a_bare_number('--run-id', flags.runId);
    const baseline = not_a_bare_number('--baseline', flags.baseline);
    const merged = merge_flags({} as VolleyConfig, flags);
    const config = resolve_config(merged, {
      mode: 'critique',
      ...(run_id !== undefined ? { run_id } : {}),
    });
    const renderer = make_renderer(config);
    warn_api_key_meter(renderer);
    if (merged.dry_run === true) {
      // A revision that isn't a commit fails the dry run as it would the critique.
      const sha = resolve_baseline(config.workspace, baseline);
      renderer.info(`baseline: ${sha ?? 'none (not a git repository, or no commit yet)'}`);
      exit_code = await preflight(config, renderer, process.env);
      return;
    }
    const result = await run_critique(config, {
      renderer,
      ...(baseline !== undefined ? { baseline } : {}),
    });
    exit_code = emit_result(config, result, renderer);
  });

  cli
    .command('matrix', 'Sweep builder×critic model combos serially over one config')
    .option('--config <path>', 'Base VolleyConfig (TS/JS): the task, workspace, providers, and caps held fixed')
    .option('--builders <models>', 'Comma-separated builder models to sweep')
    .option('--critics <models>', 'Comma-separated critic models to sweep')
    .option('--workspace <path>', 'Override the base config workspace')
    .option('--repeat <n>', 'Attempts per seat (default: 1); a pass rate needs more than one')
    .option('--json', 'Machine mode: aggregate JSON on stdout, no table')
    .option('--verbose', 'Show full builder/critic streams per combo')
    .option('--quiet', 'Per-combo phase transitions and the final table only')
    .action(async (flags: MatrixFlags) => {
      if (flags.config === undefined) {
        throw config_error('volley matrix requires --config <path> (the base task to sweep)');
      }
      const builders = parse_model_list(flags.builders, '--builders');
      const critics = parse_model_list(flags.critics, '--critics');
      const repeat = parse_repeat(flags.repeat);
      const base = await load_config_file(flags.config);
      const merged = merge_flags(base, {
        ...(flags.workspace !== undefined ? { workspace: flags.workspace } : {}),
        ...(flags.json === true ? { json: true } : {}),
        ...(flags.verbose === true ? { verbose: true } : {}),
        ...(flags.quiet === true ? { quiet: true } : {}),
      });
      // Resolve once with the forced throw-away worktree to validate the
      // git repo, providers, and task up front — before any combo spends — and to
      // build the renderer and locate the workspace-level `.volley-matrix/`
      // output. Matches what `default_run_combo` resolves per seat.
      const base_config = resolve_config({ ...merged, worktree: true, discard_worktree: true });
      const renderer = make_renderer(base_config, '<run id>');
      warn_api_key_meter(renderer);
      warn_unsandboxed_builder(base_config, renderer);
      const outcome = await run_matrix({
        base: merged,
        builders,
        critics,
        matrix_dir: join(base_config.workspace, '.volley-matrix'),
        renderer,
        repeat,
      });
      if (base_config.json) {
        process.stdout.write(`${JSON.stringify({ combos: outcome.rows }, null, 2)}\n`);
      }
      exit_code = outcome.ok ? EXIT_SUCCESS : EXIT_MATRIX_INCOMPLETE;
    });

  // `--worktree`, `--git`, and `--json` are declared only so they can be
  // refused with a reason; cac would answer an undeclared one with a bare
  // "Unknown option".
  const acp_command = cli.command('acp', 'Serve volley to an editor as an ACP agent over stdio');
  with_seat_options(acp_command, true)
    .option('--critic <critic>', 'reviewer | optimizer | researcher | path to prompt file')
    .option('--check <check>', `auto | none | shell command (default: ${DEFAULT_CHECK})`)
    .option('--max-iterations <n>', `Iteration cap per prompt (default: ${String(ACP_MAX_ITERATIONS)})`)
    .option('--max-cost-usd <usd>', 'Hard USD ceiling per prompt, enforced in the loop guard')
    .option('--state-dir <path>', STATE_DIR_HELP)
    .option('--worktree', 'Refused: a sibling worktree sits outside the project the editor has open')
    .option('--git', 'Refused: phase commits would bypass the permission prompts')
    .option('--json', 'Refused: stdout carries the protocol')
    .action(async (flags: CliFlags) => {
      const base = acp_base_config(merge_flags({} as VolleyConfig, flags));
      await serve_acp(acp_serve_config(base, { version: package_version() }));
    });

  cli.help();
  cli.version(package_version());

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
