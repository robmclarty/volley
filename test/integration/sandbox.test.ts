/**
 * Opt-in Docker sandbox test (s2 Phase 2b, step 11): VOLLEY_SANDBOX_TEST=1 pnpm test
 *
 * Exercises the real container swap end to end — the `bash` tool running via
 * `docker exec` against a long-lived, hardened container over a bind-mounted
 * worktree (D5/D9/D11). Skipped by default: it needs a running daemon and a
 * present image, so it never gates `pnpm check`. Point it at any Linux image
 * with `sh` + coreutils via VOLLEY_SANDBOX_TEST_IMAGE (default the volley image).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { docker_exec_bash, start_sandbox, stop_sandbox } from '../../src/sandbox.js';
import { temp_workspace } from '../helpers/harness.js';

const IMAGE = process.env['VOLLEY_SANDBOX_TEST_IMAGE'] ?? 'volley-sandbox:latest';

function docker_ready(): boolean {
  if (process.env['VOLLEY_SANDBOX_TEST'] !== '1') return false;
  if (spawnSync('docker', ['info'], { encoding: 'utf8' }).status !== 0) return false;
  return spawnSync('docker', ['image', 'inspect', IMAGE], { encoding: 'utf8' }).status === 0;
}

const RUN = docker_ready();
const EXEC_OPTS = { timeout_ms: 30_000, max_capture_bytes: 10_000_000 };

describe.runIf(RUN)('builder sandbox (real docker exec)', () => {
  it(
    'runs bash in the container: FS isolation, host-visible writes, stateless cwd, and reaping',
    async () => {
      const { workspace, cleanup } = temp_workspace();
      writeFileSync(join(workspace, 'host_seen.txt'), 'host-marker');
      const handle = start_sandbox({
        image: IMAGE,
        build_root: workspace,
        run_id: `itest-${String(process.pid)}-${String(Date.now())}`,
      });
      try {
        const bash = docker_exec_bash(handle);

        // Isolation: `cat /etc/passwd` reads the *container's* file, and the host
        // path to the workspace does not exist inside the container — only the
        // `/workspace` mount does. Same bytes, two views (done-when).
        const passwd = bash('cat /etc/passwd', EXEC_OPTS);
        expect(passwd.status).toBe(0);
        expect(passwd.stdout).toContain('root:x:0:0');

        const host_abs = resolve(workspace, 'host_seen.txt');
        const via_host_path = bash(`cat ${host_abs}`, EXEC_OPTS);
        expect(via_host_path.status).not.toBe(0); // host path invisible in container
        const via_mount = bash('cat host_seen.txt', EXEC_OPTS);
        expect(via_mount.status).toBe(0);
        expect(via_mount.stdout).toContain('host-marker'); // bind mount visible

        // Shape B: a container write lands host-side in the bind-mounted worktree.
        const wrote = bash('echo container-wrote > from_container.txt', EXEC_OPTS);
        expect(wrote.status).toBe(0);
        expect(readFileSync(join(workspace, 'from_container.txt'), 'utf8')).toContain(
          'container-wrote',
        );

        // Stateless per command: a `cd` in one exec does not leak into the next.
        expect(bash('cd /tmp', EXEC_OPTS).status).toBe(0);
        expect(bash('pwd', EXEC_OPTS).stdout.trim()).toBe('/workspace');

        // Reaping: a backgrounded process is gone once the command returns (the
        // executor reaps between commands), while the keep-alive `sleep infinity`
        // survives so the container stays up.
        expect(bash('sleep 300 >/dev/null 2>&1 & echo backgrounded', EXEC_OPTS).status).toBe(0);
        const cmdlines = bash(
          "for d in /proc/[0-9]*/cmdline; do cat \"$d\" 2>/dev/null | tr '\\0' ' '; echo; done",
          EXEC_OPTS,
        );
        expect(cmdlines.stdout).toContain('sleep infinity'); // keep-alive preserved
        expect(cmdlines.stdout).not.toContain('sleep 300'); // orphan reaped
      } finally {
        stop_sandbox(handle);
        cleanup();
      }
    },
    120_000,
  );

  it(
    'cannot read the host /etc/passwd — the container has its own root filesystem',
    async () => {
      const { workspace, cleanup } = temp_workspace();
      const host_passwd = readFileSync('/etc/passwd', 'utf8');
      const handle = start_sandbox({
        image: IMAGE,
        build_root: workspace,
        run_id: `itest-passwd-${String(process.pid)}-${String(Date.now())}`,
      });
      try {
        const bash = docker_exec_bash(handle);
        const sandbox_passwd = bash('cat /etc/passwd', EXEC_OPTS);
        expect(sandbox_passwd.status).toBe(0);
        // A macOS host /etc/passwd carries this boilerplate; a Linux container's
        // never does — proof the read hit the container, not the host file.
        if (host_passwd.includes('# User Database')) {
          expect(sandbox_passwd.stdout).not.toContain('# User Database');
        }
        expect(sandbox_passwd.stdout).not.toBe(host_passwd);
      } finally {
        stop_sandbox(handle);
        cleanup();
      }
    },
    120_000,
  );
});
