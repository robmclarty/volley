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
 * except across the boundary at `VOLLEY_MODEL_HOST`. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

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

/** The Ollama base URL from the environment or the localhost default,
 * normalized to the server root. A trailing `/api` (the pre-v0.3.1 documented
 * default, and a natural mistake since Ollama's REST paths all start with it)
 * is stripped rather than left to 404 every request, then a loopback authority
 * is crossed to the host LLM endpoint when volley runs contained. */
export function resolve_ollama_base_url(env: Record<string, string | undefined>): string {
  const raw = env['VOLLEY_OLLAMA_URL'] ?? DEFAULT_OLLAMA_URL;
  const normalized = raw.replace(/\/+$/, '').replace(/\/api$/, '');
  return cross_to_host_gateway(normalized, env);
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
  workspace: string;
  /** When the builder runs on a local model, its provider is configured
   * alongside claude_cli so one engine drives both roles. */
  builder_provider?: BuilderProvider;
  /** When the critic runs on a local model, its provider is configured
   * alongside claude_cli so one engine drives both roles. */
  critic_provider?: CriticProvider;
  env?: Record<string, string | undefined>;
};

/** The local (non-CLI) providers a role can select. `claude_cli` needs no
 * ai-sdk wiring, so it never appears here. */
type LocalProvider = 'ollama' | 'lmstudio';

function is_local_provider(
  provider: BuilderProvider | CriticProvider | undefined,
): provider is LocalProvider {
  return provider === 'ollama' || provider === 'lmstudio';
}

/** Add a local provider (ollama/lmstudio) to the provider map, with a base URL
 * from the environment or a sensible localhost default. The ai-sdk peer
 * (`ai-sdk-ollama` / `@ai-sdk/openai-compatible`) is loaded lazily by fascicle
 * only when the provider actually runs.
 *
 * Native transport is the deferred future bridge, not adopted here: volley stays
 * on the ai_sdk transport, which fascicle 0.12.9 already selects by default
 * (`transport?: 'ai_sdk' | 'native'` defaults to `'ai_sdk'`), so no field is
 * needed today. Flipping later is a one-line change — add `transport: 'native'`
 * to the ollama/lmstudio config object returned below. No URL re-pointing is
 * required: `resolve_ollama_base_url` already yields the daemon-root URL the
 * native `/api/chat` transport wants (its adapter appends `/api/chat` itself),
 * which is exactly what the v0.3.1 base-URL fix produces. Kept as a
 * proven-once-then-reverted option so the transport stays a clean second variable
 * in the model-vs-transport comparison.
 *
 * Both providers' base URLs cross a loopback authority to `VOLLEY_MODEL_HOST` when
 * volley runs contained, so an in-container model client reaches the
 * host LLM endpoint at `host.docker.internal`; on the host / unsandboxed path the
 * override is unset and this is a no-op. */
function local_provider_config(
  provider: LocalProvider,
  env: Record<string, string | undefined>,
): ProviderConfigMap {
  if (provider === 'ollama') {
    return { ollama: { base_url: resolve_ollama_base_url(env) } };
  }
  const lmstudio_url = env['VOLLEY_LMSTUDIO_URL'] ?? DEFAULT_LMSTUDIO_URL;
  return { lmstudio: { base_url: cross_to_host_gateway(lmstudio_url, env) } };
}

/** Per-run engine. `claude_cli` is always configured with the workspace as its
 * session cwd; any local provider selected by the builder or critic role is
 * wired in alongside it so one engine drives both roles. Binary, auth mode,
 * provider URLs, and pricing come from the environment. */
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

  // A run may select a local provider for the builder, the critic, or both
  // (even two different ones). Wire each distinct local provider once.
  const local_providers = new Set<LocalProvider>();
  if (is_local_provider(options.builder_provider)) local_providers.add(options.builder_provider);
  if (is_local_provider(options.critic_provider)) local_providers.add(options.critic_provider);

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
  for (const provider of local_providers) {
    Object.assign(providers, local_provider_config(provider, env));
  }

  return create_engine({
    providers,
    ...(pricing_path !== undefined && pricing_path.length > 0
      ? { pricing: load_pricing_overrides(pricing_path) }
      : {}),
  });
}
