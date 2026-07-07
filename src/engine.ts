/**
 * The ONLY module that calls fascicle's `create_engine` (spec §7). Every
 * other module receives an `Engine`-shaped value, which keeps the engine
 * mockable in tests and confines provider knowledge to one seam.
 */
import { existsSync, readFileSync } from 'node:fs';
import { create_engine } from 'fascicle';
import type { Engine, ProviderConfigMap, PricingTable } from 'fascicle';
import { config_error } from './types.js';
import type { CriticProvider } from './types.js';

export type { Engine } from 'fascicle';

/** LM Studio's OpenAI-compatible server and Ollama's native API defaults. */
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434/api';
export const DEFAULT_LMSTUDIO_URL = 'http://localhost:1234/v1';

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
  /** When the critic runs on a local model, its provider is configured
   * alongside claude_cli so one engine drives both roles. */
  critic_provider?: CriticProvider;
  env?: Record<string, string | undefined>;
};

/** Add the local critic provider (ollama/lmstudio) to the provider map, with
 * a base URL from the environment or a sensible localhost default. The
 * ai-sdk peer (`ai-sdk-ollama` / `@ai-sdk/openai-compatible`) is loaded
 * lazily by fascicle only when the provider actually runs. */
function local_provider_config(
  provider: 'ollama' | 'lmstudio',
  env: Record<string, string | undefined>,
): ProviderConfigMap {
  if (provider === 'ollama') {
    return { ollama: { base_url: env['VOLLEY_OLLAMA_URL'] ?? DEFAULT_OLLAMA_URL } };
  }
  return { lmstudio: { base_url: env['VOLLEY_LMSTUDIO_URL'] ?? DEFAULT_LMSTUDIO_URL } };
}

/** Per-run engine. The builder always runs on `claude_cli` with the
 * workspace as its session cwd; when `critic_provider` is a local model,
 * that provider is wired in too. Binary, auth mode, provider URLs, and
 * pricing come from the environment (spec §12). */
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
  const critic_provider = options.critic_provider ?? 'claude_cli';

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
    ...(critic_provider === 'ollama' || critic_provider === 'lmstudio'
      ? local_provider_config(critic_provider, env)
      : {}),
  };

  return create_engine({
    providers,
    ...(pricing_path !== undefined && pricing_path.length > 0
      ? { pricing: load_pricing_overrides(pricing_path) }
      : {}),
  });
}
