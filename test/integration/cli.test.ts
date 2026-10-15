/**
 * The CLI as a harness launching volley by argv sees it: spawned under tsx,
 * with `--dry-run` so nothing past config resolution and preflight runs.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXIT_CONFIG_ERROR, EXIT_SUCCESS } from '../../src/exit_codes.js';
import { temp_workspace } from '../helpers/harness.js';

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));

function dry_run(extra: string[]): { status: number | null; stderr: string } {
  const { workspace, cleanup } = temp_workspace();
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        CLI,
        '--dry-run',
        '--prompt',
        'p',
        '--criteria',
        'c',
        '--check',
        'none',
        '--workspace',
        workspace,
        ...extra,
      ],
      { encoding: 'utf8' },
    );
    return { status: result.status, stderr: result.stderr };
  } finally {
    cleanup();
  }
}

describe('volley --builder-url / --critic-url', () => {
  it('refuses a URL on the default claude_cli critic as a config error, before any spend', () => {
    const { status, stderr } = dry_run(['--critic-url', 'http://localhost:1']);
    expect(status).toBe(EXIT_CONFIG_ERROR);
    expect(stderr).toContain(
      '--critic-url (critic_url) applies only to a critic on ollama or lmstudio; ' +
        'critic-provider is claude_cli',
    );
  });

  it("sends the builder's preflight probe to its own URL", () => {
    // Port 1 refuses at once, so the probe fails fast and names the seat's URL.
    const { status, stderr } = dry_run([
      '--builder-provider',
      'lmstudio',
      '--builder-url',
      'http://127.0.0.1:1/v1',
      '--allow-unsandboxed-builder',
    ]);
    expect(status).toBe(EXIT_CONFIG_ERROR);
    expect(stderr).toContain('builder model: opus (provider: lmstudio, endpoint: http://127.0.0.1:1/v1)');
    expect(stderr).toContain('builder model endpoint unreachable: http://127.0.0.1:1/v1');
  });
});

describe('volley --run-id', () => {
  it("names the run by the caller's id", () => {
    const { status, stderr } = dry_run(['--run-id', 'night-42']);
    expect(status).toBe(EXIT_SUCCESS);
    expect(stderr).toContain('dry run: config valid (run night-42)');
  });

  it('mints a fresh UUID when no id is given', () => {
    const { status, stderr } = dry_run([]);
    expect(status).toBe(EXIT_SUCCESS);
    expect(stderr).toMatch(/dry run: config valid \(run [0-9a-f-]{36}\)/);
  });

  it('refuses an id a branch name cannot carry, as a config error', () => {
    const { status, stderr } = dry_run(['--run-id', '../escape']);
    expect(status).toBe(EXIT_CONFIG_ERROR);
    expect(stderr).toContain('--run-id must be letters, digits');
  });

  it('refuses a bare-number id rather than run under the number cac read', () => {
    const { status, stderr } = dry_run(['--run-id', '0042']);
    expect(status).toBe(EXIT_CONFIG_ERROR);
    expect(stderr).toContain('--run-id must not be a bare number (read as 42)');
  });
});
