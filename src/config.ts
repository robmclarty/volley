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
  BuilderProvider,
  CriticPreset,
  CriticProvider,
  ResolvedConfig,
  VolleyConfig,
} from './types.js';

export const DEFAULT_BUILDER_MODEL = 'opus';
export const DEFAULT_CRITIC_MODEL = 'opus';
export const DEFAULT_MAX_ITERATIONS = 10;
export const DEFAULT_BUILDER_MAX_STEPS = 50;
export const DEFAULT_CHECK = 'auto';
export const DEFAULT_CRITIC = 'reviewer';
export const DEFAULT_BUILDER_PROVIDER: BuilderProvider = 'claude_cli';
export const DEFAULT_CRITIC_PROVIDER: CriticProvider = 'claude_cli';
export const DEFAULT_PERMISSION_MODE: BuilderPermissionMode = 'acceptEdits';
/** The image volley's own `Dockerfile` builds; the local-builder sandbox runs
 * it unless `--sandbox-image` / `VOLLEY_SANDBOX_IMAGE` overrides it (s2 D5). */
export const DEFAULT_SANDBOX_IMAGE = 'volley-sandbox:latest';

const BUILDER_PROVIDERS: ReadonlyArray<BuilderProvider> = [
  'claude_cli',
  'ollama',
  'lmstudio',
];

/** Builder providers that run a local model through volley's own tool loop —
 * a real `bash` (write + exec). Refused (D11 → B′/D5) unless volley is running
 * inside a container (B′-2, the correct blast-radius default) or the operator
 * explicitly opts out; `claude_cli` has its own permission model and is
 * exempt. */
const LOCAL_BUILDER_PROVIDERS: ReadonlyArray<BuilderProvider> = [
  'ollama',
  'lmstudio',
];

const CRITIC_PROVIDERS: ReadonlyArray<CriticProvider> = [
  'claude_cli',
  'ollama',
  'lmstudio',
];

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
  env?: Record<string, string | undefined>;
};

/** `--builder-max-steps` (a merged flag/config value) wins over the
 * `VOLLEY_BUILDER_MAX_STEPS` env var, which wins over the default. Local
 * builder only; ignored by the `claude_cli` arm. */
function resolve_builder_max_steps(
  raw: VolleyConfig,
  env: Record<string, string | undefined>,
): number {
  if (raw.builder_max_steps !== undefined) {
    return validate_builder_max_steps(raw.builder_max_steps, raw.builder_max_steps);
  }
  const env_value = env['VOLLEY_BUILDER_MAX_STEPS'];
  if (env_value !== undefined && env_value !== '') {
    return validate_builder_max_steps(Number(env_value), env_value);
  }
  return DEFAULT_BUILDER_MAX_STEPS;
}

function validate_builder_max_steps(value: number, original: unknown): number {
  if (!Number.isInteger(value) || value < 1) {
    throw config_error(
      `--builder-max-steps / VOLLEY_BUILDER_MAX_STEPS must be a positive integer; got: ${String(original)}`,
    );
  }
  return value;
}

/** `--sandbox-image` (a merged flag/config value) wins over the
 * `VOLLEY_SANDBOX_IMAGE` env var, which wins over the default image. Used only
 * on the local-builder Docker sandbox path (s2 D5); the `claude_cli` path never
 * runs Docker (C4). */
function resolve_sandbox_image(
  raw: VolleyConfig,
  env: Record<string, string | undefined>,
): string {
  if (raw.sandbox_image !== undefined && raw.sandbox_image !== '') {
    return raw.sandbox_image;
  }
  const env_value = env['VOLLEY_SANDBOX_IMAGE'];
  if (env_value !== undefined && env_value !== '') {
    return env_value;
  }
  return DEFAULT_SANDBOX_IMAGE;
}

/** The `--allow-unsandboxed-builder` flag/config value wins; otherwise
 * `VOLLEY_ALLOW_UNSANDBOXED_BUILDER=1` (or `=true`) opts out. Any other value
 * (incl. `0`/`false`/unset) leaves the local builder refused unless contained
 * (D11 → B′/D5). */
function resolve_allow_unsandboxed_builder(
  raw: VolleyConfig,
  env: Record<string, string | undefined>,
): boolean {
  if (raw.allow_unsandboxed_builder === true) return true;
  const env_value = env['VOLLEY_ALLOW_UNSANDBOXED_BUILDER'];
  return env_value === '1' || env_value === 'true';
}

/** B′-2: volley *detects* it is running inside its sandbox container rather than
 * starting the container itself. The signal is the `VOLLEY_CONTAINED=1` marker
 * volley's own image bakes in (`Dockerfile` `ENV`), so a `docker run <hardened
 * flags> <image> volley run …` is recognized as contained out of the box. Kept
 * env-only — no ambient `/.dockerenv` probe — so the safety gate is deterministic
 * and testable, and so a CI job that itself runs in an unrelated container does
 * not silently satisfy the gate; a hand-rolled sandbox must set the marker (or
 * the operator uses `--allow-unsandboxed-builder`). */
export function detect_containment(env: Record<string, string | undefined>): boolean {
  const value = env['VOLLEY_CONTAINED'];
  return value === '1' || value === 'true';
}

/** Merge, expand, and validate a raw `VolleyConfig` into a `ResolvedConfig`.
 * `check_resolved` is filled in later by check detection (workspace-relative);
 * it starts as `none` and `resolve_check_runner` overrides it. */
export function resolve_config(
  raw: VolleyConfig,
  options: ResolveOptions = {},
): ResolvedConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

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

  const builder_provider = raw.builder_provider ?? DEFAULT_BUILDER_PROVIDER;
  if (!BUILDER_PROVIDERS.includes(builder_provider)) {
    throw config_error(
      `--builder-provider must be one of ${BUILDER_PROVIDERS.join(', ')}; got: ${String(raw.builder_provider)}`,
    );
  }

  // Safety gate (D11 → B′/D5): a local builder gets a real `bash` (write + exec),
  // so refuse it — before any model spend — unless volley is running *inside* a
  // container (B′-2, the correct blast-radius default) or the operator explicitly
  // opts out to run uncontained on the host.
  const allow_unsandboxed_builder = resolve_allow_unsandboxed_builder(raw, env);
  const contained = detect_containment(env);
  if (
    LOCAL_BUILDER_PROVIDERS.includes(builder_provider) &&
    !contained &&
    !allow_unsandboxed_builder
  ) {
    throw config_error(
      `builder-provider '${builder_provider}' runs a local model with a real bash ` +
        `(write + exec) — refused unless contained. Launch volley inside its sandbox container ` +
        `(docker run <hardened flags> <image> volley run …, which sets VOLLEY_CONTAINED=1), or pass ` +
        `--allow-unsandboxed-builder (VOLLEY_ALLOW_UNSANDBOXED_BUILDER=1) to run uncontained on the host.`,
    );
  }

  const builder_max_steps = resolve_builder_max_steps(raw, env);

  const critic_provider = raw.critic_provider ?? DEFAULT_CRITIC_PROVIDER;
  if (!CRITIC_PROVIDERS.includes(critic_provider)) {
    throw config_error(
      `--critic-provider must be one of ${CRITIC_PROVIDERS.join(', ')}; got: ${String(raw.critic_provider)}`,
    );
  }

  // Containment auth gate (B′/D5): `claude_cli`'s subscription/OAuth credentials
  // do not survive containerization — the token is mangled inside the container —
  // so a contained run may drive Claude only by API key (a plain env var that
  // travels the boundary). Refuse a contained `claude_cli` role (builder and/or
  // critic) that is not explicitly in `api_key` mode; the all-Claude path stays
  // on the host and Docker-free by design (C4/D10), where subscription auth works.
  if (contained) {
    const claude_roles = [
      builder_provider === 'claude_cli' ? 'builder' : null,
      critic_provider === 'claude_cli' ? 'critic' : null,
    ].filter((role): role is string => role !== null);
    const auth_mode = env['VOLLEY_AUTH_MODE'] ?? 'auto';
    if (claude_roles.length > 0 && auth_mode !== 'api_key') {
      throw config_error(
        `claude_cli (${claude_roles.join(', ')}) cannot use its subscription/OAuth token inside a ` +
          `container — it is mangled there. Set VOLLEY_AUTH_MODE=api_key (with ANTHROPIC_API_KEY) to ` +
          `drive Claude contained, or run claude_cli on the host uncontained.`,
      );
    }
  }

  if (raw.git_checkpoints === true && !existsSync(resolve(workspace, '.git'))) {
    throw config_error(`--git requires the workspace to be a git repository: ${workspace}`);
  }

  // A worktree is checked out from the workspace's git history, so refuse the
  // flag before any model spend when the workspace is not a repository (s2 D3).
  const worktree = raw.worktree ?? false;
  if (worktree && !existsSync(resolve(workspace, '.git'))) {
    throw config_error(`--worktree requires the workspace to be a git repository: ${workspace}`);
  }

  // `--discard-worktree` (D13): opt in to the throw-away mode — a converged run's
  // effects go away with its branch instead of being kept on it. Only meaningful
  // under `--worktree`, so a lone flag is refused rather than silently ignored:
  // it would otherwise read as isolation the run does not have.
  const discard_worktree = raw.discard_worktree ?? false;
  if (discard_worktree && !worktree) {
    throw config_error(
      '--discard-worktree applies only to a --worktree run: there is no worktree to discard',
    );
  }

  const sandbox_image = resolve_sandbox_image(raw, env);

  return {
    version: 2,
    run_id: options.run_id ?? randomUUID(),
    started_at: options.started_at ?? new Date().toISOString(),
    prompt,
    criteria,
    check: raw.check ?? DEFAULT_CHECK,
    check_resolved: 'none',
    builder_model: raw.builder_model ?? DEFAULT_BUILDER_MODEL,
    builder_provider,
    builder_max_steps,
    allow_unsandboxed_builder,
    critic_model: raw.critic_model ?? DEFAULT_CRITIC_MODEL,
    critic_provider,
    builder_permission_mode,
    critic_preset,
    critic_prompt_path,
    max_iterations,
    max_cost_usd,
    git_checkpoints: raw.git_checkpoints ?? false,
    worktree,
    discard_worktree,
    sandbox_image,
    workspace,
    verbose: raw.verbose ?? false,
    quiet: raw.quiet ?? false,
    json: raw.json ?? false,
    show_thinking: raw.show_thinking ?? true,
  };
}
