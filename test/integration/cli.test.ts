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

/** The developer's shell, minus anything that would decide an openrouter
 * seat's key or containment for it, plus `env`. */
function child_env(env: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    'OPENROUTER_API_KEY',
    'VOLLEY_OPENROUTER_URL',
    'VOLLEY_CONTAINED',
    'VOLLEY_ALLOW_UNSANDBOXED_BUILDER',
  ]) {
    delete base[name];
  }
  return { ...base, ...env };
}

function dry_run(
  extra: string[],
  env: Record<string, string> = {},
): { status: number | null; stderr: string } {
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
      { encoding: 'utf8', env: child_env(env) },
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
      '--critic-url (critic_url) applies only to a critic on ollama, lmstudio, or openrouter; ' +
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

describe('volley --builder-provider openrouter / --critic-provider openrouter', () => {
  const KEYED = { OPENROUTER_API_KEY: 'sk-or-test' };
  const BOTH_SEATS = ['--builder-provider', 'openrouter', '--critic-provider', 'openrouter'];

  it('exits 5 naming OPENROUTER_API_KEY when it is unset, before any work', () => {
    for (const seats of [
      [...BOTH_SEATS, '--allow-unsandboxed-builder'],
      ['--critic-provider', 'openrouter'],
    ]) {
      const { status, stderr } = dry_run(seats);
      expect(status).toBe(EXIT_CONFIG_ERROR);
      expect(stderr).toContain('OPENROUTER_API_KEY is not set');
    }
  });

  it('refuses an uncontained openrouter builder without --allow-unsandboxed-builder', () => {
    const { status, stderr } = dry_run(BOTH_SEATS, KEYED);
    expect(status).toBe(EXIT_CONFIG_ERROR);
    expect(stderr).toContain("builder-provider 'openrouter' runs volley's tool loop with a real bash");
    expect(stderr).toContain('refused unless contained');
  });

  it("probes each seat's endpoint in --dry-run, naming the one that is down", () => {
    // Port 1 refuses at once, so the probe fails fast and names the seat's URL.
    const { status, stderr } = dry_run(
      [
        ...BOTH_SEATS,
        '--builder-model',
        'vendor/builder',
        '--builder-url',
        'http://127.0.0.1:1/api/v1/',
        '--allow-unsandboxed-builder',
      ],
      KEYED,
    );
    expect(status).toBe(EXIT_CONFIG_ERROR);
    expect(stderr).toContain(
      'builder model: vendor/builder (provider: openrouter, endpoint: http://127.0.0.1:1/api/v1)',
    );
    expect(stderr).toContain('critic model: opus (provider: openrouter, endpoint: https://openrouter.ai/api/v1)');
    expect(stderr).toContain('builder model endpoint unreachable: http://127.0.0.1:1/api/v1');
  });
});

describe('volley --help', () => {
  const help = spawnSync(process.execPath, ['--import', 'tsx', CLI, '--help'], {
    encoding: 'utf8',
  }).stdout;

  it('lists openrouter for both seats', () => {
    expect(help).toMatch(/--builder-provider <name> +claude_cli \| ollama \| lmstudio \| openrouter/);
    expect(help).toMatch(/--critic-provider <name> +claude_cli \| ollama \| lmstudio \| openrouter/);
    expect(help).toMatch(/--builder-url <url> +.*VOLLEY_OPENROUTER_URL/);
    expect(help).toMatch(/--critic-url <url> +.*VOLLEY_OPENROUTER_URL/);
  });

  it('lists the run command\'s options in the order they have always had, seat options included', () => {
    const options = [...help.matchAll(/^ {2}(?:-\w, )?(--[\w-]+)/gm)].map((match) => match[1]);
    expect(options).toEqual([
      '--prompt',
      '--workspace',
      '--criteria',
      '--check',
      '--builder-model',
      '--builder-provider',
      '--builder-url',
      '--builder-max-steps',
      '--allow-unsandboxed-builder',
      '--critic-model',
      '--critic-provider',
      '--critic-url',
      '--builder-permission-mode',
      '--critic',
      '--max-iterations',
      '--max-cost-usd',
      '--git',
      '--worktree',
      '--discard-worktree',
      '--gate-paths',
      '--fail-on-gate-edit',
      '--sandbox-image',
      '--state-dir',
      '--run-id',
      '--dry-run',
      '--config',
      '--json',
      '--verbose',
      '--quiet',
      '--no-thinking',
      '--help',
      '--version',
    ]);
  });
});
