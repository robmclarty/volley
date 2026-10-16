/**
 * The check runs in a process group of its own, so stopping it stops
 * everything it started: a test runner's workers, or a server it put in the
 * background. These drive the real `sh` against a temp workspace, with the
 * background process's pid written to a file so the test can watch it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run_command_check } from '../../src/check/command.js';
import { error_kind } from '../../src/types.js';
import { temp_workspace } from '../helpers/harness.js';

/** Whether a process is still running. A killed process can linger as a
 * zombie until it's reaped, so the callers poll rather than look once. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually(condition: () => boolean, timeout_ms = 5000): Promise<boolean> {
  const deadline = Date.now() + timeout_ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

/** The pid the check's command wrote, once it has written it. */
async function background_pid(workspace: string): Promise<number> {
  const file = join(workspace, 'background.pid');
  expect(await eventually(() => existsSync(file) && readFileSync(file, 'utf8').trim() !== '')).toBe(true);
  return Number(readFileSync(file, 'utf8').trim());
}

describe('run_command_check', () => {
  it('captures the output and exit code of a command that ends on its own', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const result = await run_command_check({
        command: 'echo checked; echo warned 1>&2; exit 3',
        workspace,
      });
      expect(result.ok).toBe(false);
      expect(result.exit_code).toBe(3);
      expect(result.log).toContain('checked');
      expect(result.log).toContain('warned');
    } finally {
      cleanup();
    }
  });

  it("kills the check's whole process group when the run is aborted", async () => {
    const { workspace, cleanup } = temp_workspace();
    const abort = new AbortController();
    try {
      const running = run_command_check({
        command: 'sleep 30 & echo $! > background.pid; wait',
        workspace,
        abort: abort.signal,
      });
      const outcome = running.then(
        () => null,
        (err: unknown) => err,
      );
      const pid = await background_pid(workspace);
      expect(alive(pid)).toBe(true);
      abort.abort();
      expect(error_kind(await outcome)).toBe('aborted_error');
      expect(await eventually(() => !alive(pid))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('kills what the check left running once its shell exits', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const result = await run_command_check({
        command: 'sleep 30 & echo $! > background.pid',
        workspace,
      });
      expect(result.ok).toBe(true);
      const pid = await background_pid(workspace);
      expect(await eventually(() => !alive(pid))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('starts nothing when the run is already aborted', async () => {
    const { workspace, cleanup } = temp_workspace();
    const abort = new AbortController();
    abort.abort();
    try {
      const err = await run_command_check({
        command: 'echo started > started.txt',
        workspace,
        abort: abort.signal,
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error_kind(err)).toBe('aborted_error');
      expect(existsSync(join(workspace, 'started.txt'))).toBe(false);
    } finally {
      cleanup();
    }
  });
});
