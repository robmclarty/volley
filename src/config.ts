/**
 * Config resolution: merge CLI flags over an optional config file
 * over defaults, expand `@file` references, validate, and produce the
 * immutable `ResolvedConfig` that the run's `config.json` records.
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DEFAULT_GATE_PATTERNS } from './changes.js';
import { resolve_check_runner } from './check/detect.js';
import { detect_containment } from './containment.js';
import { openrouter_api_key, SEAT_URL_PROVIDERS, takes_seat_url } from './engine.js';
import { config_error } from './types.js';
import { default_state_root, RUN_ID_PATTERN } from './workspace.js';
import type {
  RunMode,
  BuilderPermissionMode,
  BuilderProvider,
  CriticPreset,
  CriticProvider,
  ResolvedConfig,
  VolleyConfig,
} from './types.js';

export const DEFAULT_BUILDER_MODEL = 'opus';
const DEFAULT_CRITIC_MODEL = 'opus';
export const DEFAULT_MAX_ITERATIONS = 10;
export const DEFAULT_BUILDER_MAX_STEPS = 50;
export const DEFAULT_BUILDER_MAX_TOOL_CALLS = 1;
export const DEFAULT_BUILDER_MAX_OUTPUT_TOKENS = 16384;
export const DEFAULT_CHECK = 'auto';
const DEFAULT_CRITIC = 'reviewer';
const DEFAULT_BUILDER_PROVIDER: BuilderProvider = 'claude_cli';
const DEFAULT_CRITIC_PROVIDER: CriticProvider = 'claude_cli';
const DEFAULT_PERMISSION_MODE: BuilderPermissionMode = 'acceptEdits';
/** The image volley's own `Dockerfile` builds; the local-builder sandbox runs
 * it unless `--sandbox-image` / `VOLLEY_SANDBOX_IMAGE` overrides it. */
export const DEFAULT_SANDBOX_IMAGE = 'volley-sandbox:latest';

const BUILDER_PROVIDERS: ReadonlyArray<BuilderProvider> = [
  'claude_cli',
  'ollama',
  'lmstudio',
  'openrouter',
];

/** Builder providers that drive their model through volley's own tool loop —
 * a real `bash` (write + exec), wherever the model runs. Refused unless volley
 * is running inside a container (the correct blast-radius default) or the
 * operator explicitly opts out; `claude_cli` has its own permission model and
 * is exempt. */
const TOOL_LOOP_BUILDER_PROVIDERS: ReadonlyArray<BuilderProvider> = [
  'ollama',
  'lmstudio',
  'openrouter',
];

const CRITIC_PROVIDERS: ReadonlyArray<CriticProvider> = [
  'claude_cli',
  'ollama',
  'lmstudio',
  'openrouter',
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

function is_critic_preset(value: string): value is CriticPreset {
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
  /** What happens to a tool-loop builder with nothing between its commands
   * and the host (`unguarded_builder`): the CLI `refuse`s it, the default,
   * while under `volley acp` each of its commands `ask`s a person first, which
   * takes the container's place. */
  uncontained_builder?: 'refuse' | 'ask';
  /** Where the run's state goes, in place of what the config says: `volley
   * resume` passes the root it found the run under, or null for a run an older
   * volley kept in the workspace's `.volley/`, which resumes there. */
  state_dir?: string | null;
  /** A run (the default), or a critique, which has no builder or loop. */
  mode?: RunMode;
};

/** What only a builder, or the loop around it, uses, with the flag that sets
 * each: a critique has no use for any of them, so naming one is an error
 * rather than something quietly ignored. */
const CRITIQUE_REFUSED: ReadonlyArray<readonly [keyof VolleyConfig, string]> = [
  ['builder_model', '--builder-model'],
  ['builder_provider', '--builder-provider'],
  ['builder_url', '--builder-url'],
  ['builder_max_steps', '--builder-max-steps'],
  ['builder_max_tool_calls', '--builder-max-tool-calls'],
  ['builder_max_output_tokens', '--builder-max-output-tokens'],
  ['builder_permission_mode', '--builder-permission-mode'],
  ['allow_unsandboxed_builder', '--allow-unsandboxed-builder'],
  ['sandbox_image', '--sandbox-image'],
  ['max_iterations', '--max-iterations'],
  ['max_cost_usd', '--max-cost-usd'],
  ['git_checkpoints', '--git'],
  ['worktree', '--worktree'],
  ['discard_worktree', '--discard-worktree'],
  ['fail_on_gate_edit', '--fail-on-gate-edit'],
];

function refuse_builder_settings(raw: VolleyConfig): void {
  for (const [field, flag] of CRITIQUE_REFUSED) {
    if (raw[field] !== undefined && raw[field] !== false) {
      throw config_error(
        `volley critique refuses ${flag} (${field}): a critique runs no builder and no loop`,
      );
    }
  }
}

/** A tool-loop builder's count: its step cap, its tool calls per turn, or
 * its output tokens per turn, with the value it takes when nothing sets it. */
type BuilderCount<fallback extends number | null = number> = {
  flag: string;
  env_var: string;
  fallback: fallback;
};

const BUILDER_MAX_STEPS: BuilderCount = {
  flag: '--builder-max-steps',
  env_var: 'VOLLEY_BUILDER_MAX_STEPS',
  fallback: DEFAULT_BUILDER_MAX_STEPS,
};

const BUILDER_MAX_TOOL_CALLS: BuilderCount = {
  flag: '--builder-max-tool-calls',
  env_var: 'VOLLEY_BUILDER_MAX_TOOL_CALLS',
  fallback: DEFAULT_BUILDER_MAX_TOOL_CALLS,
};

/** The builders whose turns are capped when nothing sets a cap: the local
 * ones, where nothing else bounds a turn. Ollama's MLX runner lets an unset
 * `num_predict` run to the model's trained context less the prompt, which is
 * how one qwen3.8 turn spent 30,847 tokens thinking. A hosted model on
 * OpenRouter has its own output limit, and a request for more than it allows
 * can be refused, so it's capped only when asked. */
const CAPPED_BY_DEFAULT: ReadonlyArray<BuilderProvider> = ['ollama', 'lmstudio'];

/** The output cap's flag and env var, and its default for `provider`: 16k
 * tokens on a local builder, else the provider's own limit (null). */
function builder_max_output_tokens_count(provider: BuilderProvider): BuilderCount<number | null> {
  return {
    flag: '--builder-max-output-tokens',
    env_var: 'VOLLEY_BUILDER_MAX_OUTPUT_TOKENS',
    fallback: CAPPED_BY_DEFAULT.includes(provider) ? DEFAULT_BUILDER_MAX_OUTPUT_TOKENS : null,
  };
}

/** A builder count's flag or config value wins over its env var, which wins
 * over the default, and either must be a positive integer. Local builder
 * only; ignored by the `claude_cli` arm. */
function resolve_builder_count<fallback extends number | null>(
  value: number | undefined,
  env: Record<string, string | undefined>,
  count: BuilderCount<fallback>,
): number | fallback {
  if (value !== undefined) return positive_count(value, value, count);
  const env_value = env[count.env_var];
  if (env_value !== undefined && env_value !== '') {
    return positive_count(Number(env_value), env_value, count);
  }
  return count.fallback;
}

function positive_count(
  value: number,
  original: unknown,
  count: Pick<BuilderCount, 'flag' | 'env_var'>,
): number {
  if (!Number.isInteger(value) || value < 1) {
    throw config_error(
      `${count.flag} / ${count.env_var} must be a positive integer; got: ${String(original)}`,
    );
  }
  return value;
}

/** `--sandbox-image` (a merged flag/config value) wins over the
 * `VOLLEY_SANDBOX_IMAGE` env var, which wins over the default image. Used only
 * on the local-builder Docker sandbox path; the `claude_cli` path never
 * runs Docker. */
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
 * (incl. `0`/`false`/unset) leaves a tool-loop builder refused unless
 * contained. */
function resolve_allow_unsandboxed_builder(
  raw: Pick<VolleyConfig, 'allow_unsandboxed_builder'>,
  env: Record<string, string | undefined>,
): boolean {
  if (raw.allow_unsandboxed_builder === true) return true;
  const env_value = env['VOLLEY_ALLOW_UNSANDBOXED_BUILDER'];
  return env_value === '1' || env_value === 'true';
}

/** A seat's own model server URL (`--builder-url` / `--critic-url`), trimmed,
 * or null when unset; an empty value counts as unset, as it does for the env
 * vars it overrides. Only a provider volley reaches at a base URL takes one: on
 * a `claude_cli` seat the setting would silently do nothing, so it is refused.
 * The URL must be plain http(s), with no credentials, query, or fragment:
 * volley appends API paths to it for prewarm and the context probe, which a
 * query or fragment would break, and it is persisted and printed, which
 * credentials must never be. */
function resolve_seat_url(
  seat: 'builder' | 'critic',
  value: unknown,
  provider: BuilderProvider | CriticProvider,
): string | null {
  const setting = `--${seat}-url (${seat}_url)`;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw config_error(`${setting} must be a URL string; got a ${typeof value}`);
  }
  const url = value.trim();
  if (url === '') return null;
  if (!takes_seat_url(provider)) {
    const url_providers = new Intl.ListFormat('en', { type: 'disjunction' }).format(
      SEAT_URL_PROVIDERS,
    );
    throw config_error(
      `${setting} applies only to a ${seat} on ${url_providers}; ` +
        `${seat}-provider is ${provider}`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw config_error(`${setting} must be an http(s) URL; got: ${url}`);
  }
  // Checked first, so no later message echoes the credentials back.
  if (parsed.username !== '' || parsed.password !== '') {
    throw config_error(`${setting} must not carry credentials`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw config_error(`${setting} must be an http(s) URL; got: ${url}`);
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw config_error(`${setting} must not carry a query or fragment; got: ${url}`);
  }
  return url;
}

/** `--state-dir` (`state_dir`): the root each run's state sits under at
 * `<root>/<run_id>/`, resolved against `cwd` so a resumed run finds the same
 * place. Unset, or empty as a seat URL may be, it's the default root,
 * `$XDG_STATE_HOME/volley`, else `~/.local/state/volley`: outside the
 * workspace, where no check that reads every file can trip over the run's own
 * feedback. */
function resolve_state_dir(
  value: unknown,
  cwd: string,
  env: Record<string, string | undefined>,
): string {
  if (value === undefined || value === null) return default_state_root(env);
  if (typeof value !== 'string') {
    throw config_error(`--state-dir (state_dir) must be a path string; got a ${typeof value}`);
  }
  const path = value.trim();
  return path === '' ? default_state_root(env) : resolve(cwd, path);
}

function is_writable_dir(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The run's state directory must be one volley can write: the directory
 * itself when it's there, as a contained run's mount is, else the nearest
 * directory above it, where volley creates it. Checked before any spend,
 * because otherwise the run dies as it starts on a raw EROFS or EACCES. Inside
 * the sandbox the root filesystem is read-only, so that is what an unmounted
 * run directory looks like, and the message says what to mount. */
function validate_run_state_dir(dir: string, contained: boolean): void {
  let existing = dir;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  if (is_writable_dir(existing)) return;
  throw config_error(
    contained
      ? `run state directory not writable: ${dir}. Inside the sandbox, mount the run's own host ` +
          `directory there (sandbox_run_args run_state, or -v <root>/<run id>:${dir}), created on the ` +
          'host first, and pass volley the same --run-id; or point --state-dir at a writable mount'
      : `run state directory not writable: ${dir}. Point --state-dir at a directory volley can write`,
  );
}

/** Whether a tool-loop builder's commands would reach the host with nothing in
 * between: volley isn't contained, and the operator hasn't opted out with
 * `--allow-unsandboxed-builder` or `VOLLEY_ALLOW_UNSANDBOXED_BUILDER`. */
export function unguarded_builder(
  raw: Pick<VolleyConfig, 'allow_unsandboxed_builder'>,
  env: Record<string, string | undefined>,
): boolean {
  return !detect_containment(env) && !resolve_allow_unsandboxed_builder(raw, env);
}

/** A caller's run id, held to `RUN_ID_PATTERN`; none gets a fresh UUID. */
function resolve_run_id(run_id: string | undefined): string {
  if (run_id === undefined) return randomUUID();
  if (!RUN_ID_PATTERN.test(run_id)) {
    throw config_error(
      `--run-id must be letters, digits, '-', and '_', starting with a letter or digit; got: ${run_id}`,
    );
  }
  return run_id;
}

/** Merge, expand, and validate a raw `VolleyConfig` into a `ResolvedConfig`.
 * `check_resolved` comes from check detection against the workspace, so the
 * SDK and the CLI resolve `auto` and a command check the same way. */
export function resolve_config(
  raw: VolleyConfig,
  options: ResolveOptions = {},
): ResolvedConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  // A critique runs no builder, so it reads nothing a run reads for one: the
  // builder's settings are refused, its env vars go unread, and its seat keeps
  // the defaults.
  const critique = options.mode === 'critique';
  if (critique) refuse_builder_settings(raw);
  const builder_env = critique ? {} : env;

  const has_prompt = typeof raw.prompt === 'string' && raw.prompt.length > 0;
  if (!has_prompt && !critique) {
    throw config_error('missing required option: --prompt');
  }
  if (typeof raw.workspace !== 'string' || raw.workspace.length === 0) {
    throw config_error('missing required option: --workspace');
  }
  if (typeof raw.criteria !== 'string' || raw.criteria.length === 0) {
    throw config_error('missing required option: --criteria');
  }

  const workspace = validate_workspace(resolve(cwd, raw.workspace));
  const prompt = has_prompt ? expand_at_file(raw.prompt, cwd) : '';
  const criteria = expand_at_file(raw.criteria, cwd);

  const max_iterations = raw.max_iterations ?? (critique ? 1 : DEFAULT_MAX_ITERATIONS);
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

  // Safety gate: a tool-loop builder gets a real `bash` (write + exec), local
  // model or hosted, so refuse it — before any model spend — unless volley is
  // running *inside* a container (the correct blast-radius default) or the
  // operator explicitly opts out to run uncontained on the host. Under acp,
  // a person approves each command instead, so nothing is refused here.
  const allow_unsandboxed_builder = resolve_allow_unsandboxed_builder(raw, builder_env);
  const contained = detect_containment(env);
  if (
    TOOL_LOOP_BUILDER_PROVIDERS.includes(builder_provider) &&
    options.uncontained_builder !== 'ask' &&
    unguarded_builder(raw, builder_env)
  ) {
    throw config_error(
      `builder-provider '${builder_provider}' runs volley's tool loop with a real bash ` +
        `(write + exec) — refused unless contained. Launch volley inside its sandbox container ` +
        `(docker run <hardened flags> <image> volley run …, which sets VOLLEY_CONTAINED=1), or pass ` +
        `--allow-unsandboxed-builder (VOLLEY_ALLOW_UNSANDBOXED_BUILDER=1) to run uncontained on the host.`,
    );
  }

  const builder_max_steps = resolve_builder_count(raw.builder_max_steps, builder_env, BUILDER_MAX_STEPS);
  const builder_max_tool_calls = resolve_builder_count(
    raw.builder_max_tool_calls,
    builder_env,
    BUILDER_MAX_TOOL_CALLS,
  );
  const builder_max_output_tokens = resolve_builder_count(
    raw.builder_max_output_tokens,
    builder_env,
    builder_max_output_tokens_count(builder_provider),
  );

  const critic_provider = raw.critic_provider ?? DEFAULT_CRITIC_PROVIDER;
  if (!CRITIC_PROVIDERS.includes(critic_provider)) {
    throw config_error(
      `--critic-provider must be one of ${CRITIC_PROVIDERS.join(', ')}; got: ${String(raw.critic_provider)}`,
    );
  }

  const builder_url = resolve_seat_url('builder', raw.builder_url, builder_provider);
  const critic_url = resolve_seat_url('critic', raw.critic_url, critic_provider);

  // An openrouter seat sends `OPENROUTER_API_KEY`, so an unset key is refused
  // here, naming the variable, before any work rather than at the first call.
  if (builder_provider === 'openrouter' || critic_provider === 'openrouter') {
    openrouter_api_key(env);
  }

  // Containment auth gate: `claude_cli`'s subscription/OAuth credentials
  // do not survive containerization — the token is mangled inside the container —
  // so a contained run may drive Claude only by API key (a plain env var that
  // travels the boundary). Refuse a contained `claude_cli` role (builder and/or
  // critic) that is not explicitly in `api_key` mode; the all-Claude path stays
  // on the host and Docker-free by design, where subscription auth works.
  if (contained) {
    const claude_roles = [
      builder_provider === 'claude_cli' && !critique ? 'builder' : null,
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
  // flag before any model spend when the workspace is not a repository.
  const worktree = raw.worktree ?? false;
  if (worktree && !existsSync(resolve(workspace, '.git'))) {
    throw config_error(`--worktree requires the workspace to be a git repository: ${workspace}`);
  }

  // `--discard-worktree`: opt in to the throw-away mode — a converged run's
  // effects go away with its branch instead of being kept on it. Only meaningful
  // under `--worktree`, so a lone flag is refused rather than silently ignored:
  // it would otherwise read as isolation the run does not have.
  const discard_worktree = raw.discard_worktree ?? false;
  if (discard_worktree && !worktree) {
    throw config_error(
      '--discard-worktree applies only to a --worktree run: there is no worktree to discard',
    );
  }

  // What counts as the gate is the task's call, so a config's own list replaces
  // the defaults outright rather than extending them: a test-writing task owns
  // its tests, and an empty list turns the report off entirely.
  const gate_paths = raw.gate_paths ?? DEFAULT_GATE_PATTERNS;
  if (!Array.isArray(gate_paths) || gate_paths.some((glob) => typeof glob !== 'string')) {
    throw config_error('gate_paths must be an array of glob strings');
  }

  const sandbox_image = resolve_sandbox_image(raw, builder_env);
  const state_dir =
    options.state_dir !== undefined ? options.state_dir : resolve_state_dir(raw.state_dir, cwd, env);
  // Each run's folder would land among the workspace's own files, where no
  // exclusion can tell earlier runs' state from the builder's work.
  if (state_dir === workspace) {
    throw config_error(`--state-dir (state_dir) can't be the workspace itself: ${workspace}`);
  }
  const run_id = resolve_run_id(options.run_id);
  // A legacy `.volley/` lives in the workspace, already checked writable.
  if (state_dir !== null) validate_run_state_dir(join(state_dir, run_id), contained);
  const check = raw.check ?? DEFAULT_CHECK;

  return {
    version: 2,
    run_id,
    started_at: options.started_at ?? new Date().toISOString(),
    mode: critique ? 'critique' : 'run',
    prompt,
    criteria,
    check,
    check_resolved: resolve_check_runner(check, workspace),
    builder_model: raw.builder_model ?? DEFAULT_BUILDER_MODEL,
    builder_provider,
    builder_url,
    builder_max_steps,
    builder_max_tool_calls,
    builder_max_output_tokens,
    allow_unsandboxed_builder,
    critic_model: raw.critic_model ?? DEFAULT_CRITIC_MODEL,
    critic_provider,
    critic_url,
    builder_permission_mode,
    critic_preset,
    critic_prompt_path,
    max_iterations,
    max_cost_usd,
    git_checkpoints: raw.git_checkpoints ?? false,
    worktree,
    discard_worktree,
    gate_paths: [...gate_paths],
    fail_on_gate_edit: raw.fail_on_gate_edit ?? false,
    sandbox_image,
    state_dir,
    workspace,
    verbose: raw.verbose ?? false,
    quiet: raw.quiet ?? false,
    json: raw.json ?? false,
    show_thinking: raw.show_thinking ?? true,
  };
}
