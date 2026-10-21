/**
 * Every test file gets its own `XDG_STATE_HOME`, a temp directory removed when
 * the file finishes, so a run that keeps its state under the default root
 * writes there and never into the developer's `~/.local/state/volley`. CLI
 * subprocesses inherit it. A test that resolves a config with an `env` of its
 * own doesn't see it, so it names its state root itself.
 *
 * One that forgets falls back to the real root, so the file fails if a run
 * whose workspace was a temp directory turns up there while it runs, and that
 * run's folder is removed. A real run's workspace is never under the system
 * temp directory, so nothing of the developer's is touched.
 *
 * `XDG_CONFIG_HOME` points at a temp directory too, so the key volley signs
 * run configs with is made there, not in `~/.config/volley`. A key that turns
 * up there during the file fails it, and is left in place, since one created
 * at the same moment by a real run would be the developer's.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { trust_key_path } from '../src/trust.js';
import { default_state_root } from '../src/workspace.js';

const state_home = mkdtempSync(join(tmpdir(), 'volley-state-home-'));
process.env['XDG_STATE_HOME'] = state_home;
const config_home = mkdtempSync(join(tmpdir(), 'volley-config-home-'));
process.env['XDG_CONFIG_HOME'] = config_home;

/** The key a signing with no `XDG_CONFIG_HOME` of its own would make. */
const real_key = trust_key_path({}, homedir());
const real_key_before = existsSync(real_key);

/** Where a run resolved with an env that names no `XDG_STATE_HOME` lands. */
const real_root = default_state_root({}, homedir());

function real_entries(): string[] {
  return existsSync(real_root) ? readdirSync(real_root) : [];
}

const before = new Set(real_entries());

function a_test_run(dir: string): boolean {
  try {
    const recorded = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as {
      workspace?: unknown;
    };
    return typeof recorded.workspace === 'string' && recorded.workspace.startsWith(tmpdir());
  } catch {
    return false;
  }
}

afterAll(() => {
  rmSync(state_home, { recursive: true, force: true });
  rmSync(config_home, { recursive: true, force: true });
  if (!real_key_before && existsSync(real_key)) {
    throw new Error(
      `a test made volley's signing key at ${real_key}: pass a signing env an XDG_CONFIG_HOME, ` +
        'or remove the key if no real run made it',
    );
  }
  const leaked = real_entries().filter(
    (entry) => !before.has(entry) && a_test_run(join(real_root, entry)),
  );
  for (const entry of leaked) rmSync(join(real_root, entry), { recursive: true, force: true });
  if (leaked.length > 0) {
    throw new Error(
      `test runs wrote their state into ${real_root} (${leaked.join(', ')}), now removed: ` +
        'a test that passes its own env must give it an XDG_STATE_HOME or name a state root',
    );
  }
});
