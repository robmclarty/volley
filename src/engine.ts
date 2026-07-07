/**
 * The ONLY module that calls fascicle's `create_engine` (spec §7). Every
 * other module receives an `Engine`-shaped value, which keeps the engine
 * mockable in tests and confines provider knowledge to one seam.
 */
import { existsSync, readFileSync } from 'node:fs';
import { create_engine } from 'fascicle';
import type { Engine, PricingTable } from 'fascicle';
import { config_error } from './types.js';

export type { Engine } from 'fascicle';

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
  env?: Record<string, string | undefined>;
};

/** Per-run engine wired to the `claude_cli` provider with the workspace as
 * the session cwd. Binary, auth mode, and pricing come from the environment
 * (spec §12). */
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

  return create_engine({
    providers: {
      claude_cli: {
        default_cwd: options.workspace,
        setting_sources: ['project', 'local'],
        auth_mode,
        ...(binary !== undefined && binary.length > 0 ? { binary } : {}),
        ...(auth_mode === 'api_key' && env['ANTHROPIC_API_KEY'] !== undefined
          ? { api_key: env['ANTHROPIC_API_KEY'] }
          : {}),
      },
    },
    ...(pricing_path !== undefined && pricing_path.length > 0
      ? { pricing: load_pricing_overrides(pricing_path) }
      : {}),
  });
}
