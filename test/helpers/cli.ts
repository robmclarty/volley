/**
 * The CLI as a child process, spawned under tsx from the repo, where tsx
 * resolves, and without blocking this process, so stand-in servers in it can
 * answer the child's requests.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));

export type CliResult = { status: number | null; stdout: string; stderr: string };

/** The developer's shell, minus anything that would re-point, reprice,
 * re-key, or contain a seat, plus `extra`. */
export function cli_env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    'OPENROUTER_API_KEY',
    'VOLLEY_OPENROUTER_URL',
    'VOLLEY_CONTAINED',
    'VOLLEY_ALLOW_UNSANDBOXED_BUILDER',
    'VOLLEY_MODEL_HOST',
    'VOLLEY_PRICING_PATH',
  ]) {
    delete env[name];
  }
  return { ...env, VOLLEY_AUTH_MODE: 'auto', ...extra };
}

export function spawn_cli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}
