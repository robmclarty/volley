/**
 * The ONLY module that calls fascicle's `create_engine`. Every
 * other module receives an `Engine`-shaped value, which keeps the engine
 * mockable in tests and confines provider knowledge to one seam.
 */
import { existsSync, readFileSync } from 'node:fs';
import { create_engine } from 'fascicle';
import type { Engine, ProviderConfigMap, PricingTable } from 'fascicle';
import { config_error } from './types.js';
import type { BuilderProvider, CriticProvider } from './types.js';

export type { Engine } from 'fascicle';

/** LM Studio's OpenAI-compatible server and Ollama's server-root defaults.
 * The Ollama URL is the server root, NOT `…/api`: `ai-sdk-ollama` appends
 * `/api/...` itself, so a base URL ending in `/api` requests `/api/api/chat`
 * and 404s. */
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
export const DEFAULT_LMSTUDIO_URL = 'http://localhost:1234/v1';

/** Loopback authorities the container→host crossing rewrites. A base URL
 * pointing at one of these is local to wherever volley runs; contained, that is
 * *inside* the sandbox container, where the host LLM daemon is unreachable
 * except across the boundary at `VOLLEY_MODEL_HOST`. `URL.hostname` keeps an
 * IPv6 literal's brackets, so the IPv6 loopback is spelled `[::1]`. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

/** Cross a loopback base URL to the host LLM endpoint. When volley
 * runs inside its sandbox container the local model daemon is on the *host*, so
 * the example's `docker run` injects `VOLLEY_MODEL_HOST=host.docker.internal`
 * (the host-gateway allowlist target; see `sandbox_invocation` in
 * `src/sandbox.ts`). This normalizer *consumes that override* and swaps a
 * loopback host for the gateway, so an unchanged `http://localhost:11434` still
 * reaches the host from in-container. A non-loopback URL (a real remote daemon)
 * is left untouched, and an unset `VOLLEY_MODEL_HOST` (the host / unsandboxed
 * path) is a no-op — so the default and all-Claude paths are unaffected. */
export function cross_to_host_gateway(
  base_url: string,
  env: Record<string, string | undefined>,
): string {
  const host = env['VOLLEY_MODEL_HOST'];
  if (host === undefined || host === '') return base_url;
  let parsed: URL;
  try {
    parsed = new URL(base_url);
  } catch {
    return base_url;
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return base_url;
  parsed.hostname = host;
  // `URL` re-serializes `http://host:port` with a trailing `/`; drop it so the
  // Ollama server-root shape (no path) is preserved, while a real path (LM
  // Studio's `/v1`) is left intact.
  return parsed.toString().replace(/\/$/, '');
}

/** The providers a seat reaches at a base URL volley configures. `claude_cli`
 * picks its own endpoint, so it never appears here. */
type UrlProvider = 'ollama' | 'lmstudio';

/** Where a URL-taking provider's base URL comes from when a seat names none of
 * its own: the provider's env var, then its default. `normalize` canonicalizes
 * a URL from any source, so two spellings of one server compare equal. */
type SeatUrlSource = {
  env: string;
  default_url: string;
  normalize: (url: string) => string;
};

function strip_trailing_slashes(url: string): string {
  return url.replace(/\/+$/, '');
}

const SEAT_URL_SOURCES: Readonly<Record<UrlProvider, SeatUrlSource>> = {
  // A trailing `/api` (the pre-v0.3.1 documented default, and a natural mistake
  // since Ollama's REST paths all start with it) is stripped rather than left
  // to 404 every request.
  ollama: {
    env: 'VOLLEY_OLLAMA_URL',
    default_url: DEFAULT_OLLAMA_URL,
    normalize: (url) => strip_trailing_slashes(url).replace(/\/api$/, ''),
  },
  // LM Studio's base URL keeps its `/v1`: the OpenAI-compatible client appends
  // `/chat/completions` to it.
  lmstudio: {
    env: 'VOLLEY_LMSTUDIO_URL',
    default_url: DEFAULT_LMSTUDIO_URL,
    normalize: strip_trailing_slashes,
  },
};

/** The providers that take a seat URL (`--builder-url` / `--critic-url`). */
export const SEAT_URL_PROVIDERS = Object.keys(SEAT_URL_SOURCES) as ReadonlyArray<UrlProvider>;

/** Whether a seat on `provider` reaches its model at a base URL volley
 * configures, and so takes a URL of its own. */
export function takes_seat_url(
  provider: BuilderProvider | CriticProvider | undefined,
): provider is UrlProvider {
  return (SEAT_URL_PROVIDERS as ReadonlyArray<string | undefined>).includes(provider);
}

/** An absent, empty, or all-whitespace value counts as unset. */
function present(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** The base URL a seat's model calls go to: the seat's own URL, else the
 * provider's env var (`VOLLEY_OLLAMA_URL` / `VOLLEY_LMSTUDIO_URL`), else its
 * default. A seat never falls back to the other seat's URL. The result is
 * normalized, then a loopback authority is crossed to the host LLM endpoint
 * when volley runs contained. Both seats can be loopback URLs on different
 * ports, and each crosses on its own port. */
export function seat_base_url(
  provider: UrlProvider,
  seat_url: string | null,
  env: Record<string, string | undefined>,
): string {
  const source = SEAT_URL_SOURCES[provider];
  const raw = present(seat_url) ?? present(env[source.env]) ?? source.default_url;
  return cross_to_host_gateway(source.normalize(raw), env);
}

function load_pricing_overrides(path: string): PricingTable {
  if (!existsSync(path)) {
    throw config_error(`VOLLEY_PRICING_PATH not found: ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PricingTable;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw config_error(`VOLLEY_PRICING_PATH is not valid JSON: ${detail}`);
  }
}

export type EngineOptions = {
  /** The Claude session's working directory. A run passes its build root, which
   * is the worktree under `--worktree`, so the builder writes where the check
   * and the critic look. */
  workspace: string;
  /** When the builder runs on a local model, its provider is configured
   * alongside claude_cli so one engine drives both roles. */
  builder_provider?: BuilderProvider;
  /** The builder seat's own base URL (`--builder-url`); null or absent falls
   * back to the provider's env var, then its default. */
  builder_url?: string | null;
  /** When the critic runs on a local model, its provider is configured
   * alongside claude_cli so one engine drives both roles. */
  critic_provider?: CriticProvider;
  /** The critic seat's own base URL (`--critic-url`), resolved the same way. */
  critic_url?: string | null;
  env?: Record<string, string | undefined>;
};

/** A seat's provider entry, with the base URL resolved for that seat. The ai-sdk
 * peer (`ai-sdk-ollama` / `@ai-sdk/openai-compatible`) is loaded lazily by
 * fascicle only when the provider actually runs. The entry is complete, because
 * `Engine.with_providers` replaces a provider's whole entry: whatever this
 * returns is all a seat's derived engine knows about the provider.
 *
 * Native transport is the deferred future bridge, not adopted here: volley stays
 * on the ai_sdk transport, which fascicle 0.14.0 already selects by default
 * (`transport?: 'ai_sdk' | 'native'` defaults to `'ai_sdk'`), so no field is
 * needed today. Flipping later is a one-line change — add `transport: 'native'`
 * to the ollama/lmstudio entry returned below, which both seats' engines then
 * share. No URL re-pointing is required: `seat_base_url` already yields the
 * daemon-root URL the native `/api/chat` transport wants (its adapter appends
 * `/api/chat` itself), which is exactly what the v0.3.1 base-URL fix produces.
 * Kept as a proven-once-then-reverted option so the transport stays a clean
 * second variable in the model-vs-transport comparison. Flipping it today would
 * also lose the reasoning: fascicle's native Ollama adapter drops
 * `message.thinking`, with `think` unset or true (robmclarty/fascicle#12), so a
 * thinking seat's reasoning would vanish from the terminal and the trajectory.
 *
 * Both providers' base URLs cross a loopback authority to `VOLLEY_MODEL_HOST` when
 * volley runs contained, so an in-container model client reaches the
 * host LLM endpoint at `host.docker.internal`; on the host / unsandboxed path the
 * override is unset and this is a no-op. */
function seat_provider_config(
  provider: UrlProvider,
  seat_url: string | null,
  env: Record<string, string | undefined>,
): ProviderConfigMap {
  const base_url = seat_base_url(provider, seat_url, env);
  return provider === 'ollama' ? { ollama: { base_url } } : { lmstudio: { base_url } };
}

/** Per-run engine. `claude_cli` is always configured with `options.workspace`
 * (the run's build root) as its session cwd; any URL-taking provider selected
 * by the builder or critic role is wired in alongside it, at that seat's URL,
 * so one engine drives both roles. An engine holds one URL per provider, so on
 * a provider both seats share it carries the builder's; `create_seat_engines`
 * gives the critic its own engine when its URL differs. Binary, auth mode,
 * fallback provider URLs, and pricing come from the environment. */
export function create_volley_engine(options: EngineOptions): Engine {
  const env = options.env ?? process.env;

  const auth_mode = env['VOLLEY_AUTH_MODE'] ?? 'auto';
  if (auth_mode !== 'auto' && auth_mode !== 'oauth' && auth_mode !== 'api_key') {
    throw config_error(
      `VOLLEY_AUTH_MODE must be auto, oauth, or api_key; got: ${auth_mode}`,
    );
  }

  const binary = env['VOLLEY_CLAUDE_BIN'];
  const pricing_path = env['VOLLEY_PRICING_PATH'];

  const providers: ProviderConfigMap = {
    claude_cli: {
      default_cwd: options.workspace,
      setting_sources: ['project', 'local'],
      auth_mode,
      ...(binary !== undefined && binary.length > 0 ? { binary } : {}),
      ...(auth_mode === 'api_key' && env['ANTHROPIC_API_KEY'] !== undefined
        ? { api_key: env['ANTHROPIC_API_KEY'] }
        : {}),
    },
  };
  // A run may select a URL-taking provider for the builder, the critic, or both
  // (even two different ones). The critic's goes in first, so a critic-only
  // engine (the dry-run canary's) gets the critic's URL, and on a provider both
  // seats share, the builder's URL wins.
  if (takes_seat_url(options.critic_provider)) {
    Object.assign(
      providers,
      seat_provider_config(options.critic_provider, options.critic_url ?? null, env),
    );
  }
  if (takes_seat_url(options.builder_provider)) {
    Object.assign(
      providers,
      seat_provider_config(options.builder_provider, options.builder_url ?? null, env),
    );
  }

  return create_engine({
    providers,
    ...(pricing_path !== undefined && pricing_path.length > 0
      ? { pricing: load_pricing_overrides(pricing_path) }
      : {}),
  });
}

/** The engine each seat's model calls go through. */
export type SeatEngines = { builder: Engine; critic: Engine };

/** One engine per seat, shared unless it can't be. fascicle fixes one base URL
 * per provider when it builds an engine, so two seats on the same provider at
 * different URLs need two engines: the critic's is derived from the builder's
 * with `with_providers`, which keeps claude_cli, auth, and pricing and
 * overrides only the shared provider's entry. Every other pairing, including a
 * run that sets no seat URL at all, gets the one engine a run has always had. */
export async function create_seat_engines(options: EngineOptions): Promise<SeatEngines> {
  const env = options.env ?? process.env;
  const builder = create_volley_engine(options);
  const provider = options.critic_provider;
  if (
    provider !== options.builder_provider ||
    !takes_seat_url(provider) ||
    seat_base_url(provider, options.builder_url ?? null, env) ===
      seat_base_url(provider, options.critic_url ?? null, env)
  ) {
    return { builder, critic: builder };
  }
  try {
    const critic = builder.with_providers(
      seat_provider_config(provider, options.critic_url ?? null, env),
    );
    return { builder, critic };
  } catch (err) {
    // Nothing has run on the builder's engine yet; release it, not leak it.
    await builder.dispose();
    throw err;
  }
}

/** Dispose each distinct seat engine once. Both disposals start together, so
 * one that fails doesn't keep the other from running. */
export async function dispose_seat_engines(engines: SeatEngines): Promise<void> {
  const distinct =
    engines.critic === engines.builder ? [engines.builder] : [engines.builder, engines.critic];
  await Promise.all(distinct.map((engine) => engine.dispose()));
}
