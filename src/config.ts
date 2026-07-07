/**
 * Config resolution (spec §5): merge CLI flags over an optional config file
 * over defaults, expand `@file` references, validate, and produce the
 * immutable `ResolvedConfig` that `.volley/config.json` records.
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { config_error } from './types.js';
import type {
  BuilderPermissionMode,
  CriticPreset,
  ResolvedConfig,
  VolleyConfig,
} from './types.js';

export const DEFAULT_BUILDER_MODEL = 'opus';
export const DEFAULT_CRITIC_MODEL = 'opus';
export const DEFAULT_MAX_ITERATIONS = 10;
export const DEFAULT_CHECK = 'auto';
export const DEFAULT_CRITIC = 'reviewer';
export const DEFAULT_PERMISSION_MODE: BuilderPermissionMode = 'acceptEdits';

const CRITIC_PRESETS: ReadonlyArray<CriticPreset> = [
  'reviewer',
  'optimizer',
  'researcher',
];

const PERMISSION_MODES: ReadonlyArray<BuilderPermissionMode> = [
  'acceptEdits',
  'bypassPermissions',
];

/** `@path/to/file` reads the file; any other string passes through. */
export function expand_at_file(value: string, cwd: string): string {
  if (!value.startsWith('@')) return value;
  const path = resolve(cwd, value.slice(1));
  if (!existsSync(path)) {
    throw config_error(`file not found: ${path} (from ${value})`);
  }
  return readFileSync(path, 'utf8');
}

export function is_critic_preset(value: string): value is CriticPreset {
  return (CRITIC_PRESETS as ReadonlyArray<string>).includes(value);
}

/** Load a `volley.config.ts` / `.js` file's default export. */
export async function load_config_file(path: string): Promise<VolleyConfig> {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    throw config_error(`config file not found: ${abs}`);
  }
  let loaded: unknown;
  try {
    const mod = (await import(pathToFileURL(abs).href)) as {
      default?: unknown;
    };
    loaded = mod.default;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw config_error(`failed to load config file ${abs}: ${detail}`);
  }
  if (typeof loaded !== 'object' || loaded === null) {
    throw config_error(`config file ${abs} must default-export a VolleyConfig object`);
  }
  return loaded as VolleyConfig;
}

function validate_workspace(workspace: string): string {
  const abs = isAbsolute(workspace) ? workspace : resolve(workspace);
  if (!existsSync(abs)) {
    throw config_error(`workspace not found: ${abs}`);
  }
  if (!statSync(abs).isDirectory()) {
    throw config_error(`workspace is not a directory: ${abs}`);
  }
  try {
    accessSync(abs, constants.W_OK);
  } catch {
    throw config_error(`workspace not writable: ${abs}`);
  }
  return abs;
}

function resolve_critic(
  critic: string,
  cwd: string,
): { critic_preset: CriticPreset | 'custom'; critic_prompt_path: string | null } {
  if (is_critic_preset(critic)) {
    return { critic_preset: critic, critic_prompt_path: null };
  }
  const path = resolve(cwd, critic);
  if (!existsSync(path)) {
    throw config_error(
      `--critic must be one of ${CRITIC_PRESETS.join(', ')} or a path to a prompt file; got: ${critic}`,
    );
  }
  return { critic_preset: 'custom', critic_prompt_path: path };
}

export type ResolveOptions = {
  cwd?: string;
  run_id?: string;
  started_at?: string;
};

/** Merge, expand, and validate a raw `VolleyConfig` into a `ResolvedConfig`.
 * `check_resolved` is filled in later by check detection (workspace-relative);
 * it starts as `none` and `resolve_check_runner` overrides it. */
export function resolve_config(
  raw: VolleyConfig,
  options: ResolveOptions = {},
): ResolvedConfig {
  const cwd = options.cwd ?? process.cwd();

  if (typeof raw.prompt !== 'string' || raw.prompt.length === 0) {
    throw config_error('missing required option: --prompt');
  }
  if (typeof raw.workspace !== 'string' || raw.workspace.length === 0) {
    throw config_error('missing required option: --workspace');
  }
  if (typeof raw.criteria !== 'string' || raw.criteria.length === 0) {
    throw config_error('missing required option: --criteria');
  }

  const workspace = validate_workspace(resolve(cwd, raw.workspace));
  const prompt = expand_at_file(raw.prompt, cwd);
  const criteria = expand_at_file(raw.criteria, cwd);

  const max_iterations = raw.max_iterations ?? DEFAULT_MAX_ITERATIONS;
  if (!Number.isInteger(max_iterations) || max_iterations < 1) {
    throw config_error(`--max-iterations must be a positive integer; got: ${String(raw.max_iterations)}`);
  }

  const max_cost_usd = raw.max_cost_usd ?? null;
  if (max_cost_usd !== null && !(typeof max_cost_usd === 'number' && max_cost_usd > 0)) {
    throw config_error(`--max-cost-usd must be a positive number; got: ${String(raw.max_cost_usd)}`);
  }

  const builder_permission_mode = raw.builder_permission_mode ?? DEFAULT_PERMISSION_MODE;
  if (!PERMISSION_MODES.includes(builder_permission_mode)) {
    throw config_error(
      `--builder-permission-mode must be one of ${PERMISSION_MODES.join(', ')}; got: ${String(raw.builder_permission_mode)}`,
    );
  }

  const { critic_preset, critic_prompt_path } = resolve_critic(
    raw.critic ?? DEFAULT_CRITIC,
    cwd,
  );

  if (raw.git_checkpoints === true && !existsSync(resolve(workspace, '.git'))) {
    throw config_error(`--git requires the workspace to be a git repository: ${workspace}`);
  }

  return {
    version: 2,
    run_id: options.run_id ?? randomUUID(),
    started_at: options.started_at ?? new Date().toISOString(),
    prompt,
    criteria,
    check: raw.check ?? DEFAULT_CHECK,
    check_resolved: 'none',
    builder_model: raw.builder_model ?? DEFAULT_BUILDER_MODEL,
    critic_model: raw.critic_model ?? DEFAULT_CRITIC_MODEL,
    builder_permission_mode,
    critic_preset,
    critic_prompt_path,
    max_iterations,
    max_cost_usd,
    git_checkpoints: raw.git_checkpoints ?? false,
    workspace,
    verbose: raw.verbose ?? false,
    quiet: raw.quiet ?? false,
    json: raw.json ?? false,
    show_thinking: raw.show_thinking ?? true,
  };
}
