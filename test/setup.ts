/**
 * Every test file gets its own `XDG_STATE_HOME`, a temp directory removed when
 * the file finishes, so a run that keeps its state under the default root
 * writes there and never into the developer's `~/.local/state/volley`. CLI
 * subprocesses inherit it. A test that resolves a config with an `env` of its
 * own doesn't see it, so it names its state root itself.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const state_home = mkdtempSync(join(tmpdir(), 'volley-state-home-'));
process.env['XDG_STATE_HOME'] = state_home;

afterAll(() => {
  rmSync(state_home, { recursive: true, force: true });
});
