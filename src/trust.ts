/**
 * Which run configs a host-side resume may trust. A resume runs what a run's
 * `config.json` says: its check, a shell command, and its seats, permission
 * mode and prompt included. Inside the sandbox the builder runs arbitrary
 * commands with write access to its own run's state, so a contained run's
 * config is the builder's to rewrite, and resuming it on the host would run
 * whatever the builder left there.
 *
 * So volley on the host signs each config it writes, an HMAC under a key of
 * this machine's that never enters the container, and a host-side resume
 * trusts only a config whose signature holds. Inside the sandbox nothing is
 * signed, since the key isn't there and one made there would be in the
 * builder's reach, so a contained run's config never carries a signature the
 * host accepts, and the builder can't forge one without the key.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { detect_containment } from './containment.js';

type Env = Readonly<Record<string, string | undefined>>;

/** Prefixed to what is signed, so a signature over a run config can't pass for
 * one over anything else under the same key. */
const DOMAIN = 'volley run config v1\n';

/** Where this machine's key lives: `$XDG_CONFIG_HOME/volley/run-key`, else
 * `~/.config/volley/run-key`, outside every state root, so a container a run
 * root is mounted into still can't read it. A relative `XDG_CONFIG_HOME` is
 * ignored, as the XDG spec says. */
export function trust_key_path(env: Env, home: string = homedir()): string {
  const xdg = env['XDG_CONFIG_HOME'];
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, '.config');
  return join(base, 'volley', 'run-key');
}

function error_code(err: unknown): unknown {
  return (err as { code?: unknown }).code;
}

/** The key as stored, or null when there is none or it isn't one. */
function read_key(path: string): Buffer | null {
  try {
    const hex = readFileSync(path, 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
  } catch {
    return null;
  }
}

/** The key, created on first use: 32 random bytes in a file only its user can
 * read, in a directory only its user can enter. Two runs that start together
 * race to create it; the loser reads the winner's. */
function machine_key(env: Env): Buffer | null {
  const path = trust_key_path(env);
  const existing = read_key(path);
  if (existing !== null) return existing;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (error_code(err) !== 'EEXIST') return null;
  }
  return read_key(path);
}

function hmac(key: Buffer, config_text: string): string {
  return createHmac('sha256', key).update(DOMAIN).update(config_text).digest('hex');
}

/** This machine's signature over a run's `config.json` text, or null where
 * there's none to give: inside the sandbox, or when the key can't be read or
 * created. */
export function sign_config(config_text: string, env: Env = process.env): string | null {
  if (detect_containment(env)) return null;
  const key = machine_key(env);
  return key === null ? null : hmac(key, config_text);
}

/** Does `signature` hold for `config_text` under this machine's key? Never
 * creates the key: with none there's nothing it could hold under. */
export function config_signed(
  config_text: string,
  signature: string | null,
  env: Env = process.env,
): boolean {
  if (signature === null) return false;
  const key = read_key(trust_key_path(env));
  if (key === null) return false;
  const expected = Buffer.from(hmac(key, config_text), 'hex');
  const given = Buffer.from(signature.trim(), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
