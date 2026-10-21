/**
 * Opt-in Docker sandbox test: VOLLEY_SANDBOX_TEST=1 pnpm test
 *
 * Exercises the real container the invocation spec produces — the hardened
 * `sandbox_run_args` argv run as a one-shot `docker run --rm`. It
 * proves the isolation contract still holds under whole-process containment: a
 * command inside sees the *container's* root filesystem (not the host's), writes
 * land host-side in the bind-mounted worktree and the run's mounted state
 * directory, no other run's state is in reach, and `--network none` leaves no
 * route off the box. Skipped by default: it needs a running daemon and a present
 * image, so it never gates `pnpm check`. Point it at any Linux image with `sh`
 * via VOLLEY_SANDBOX_TEST_IMAGE (default the volley image); `--entrypoint sh`
 * overrides the image's `volley` entrypoint so a raw shell script can run.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SANDBOX_STATE_ROOT, sandbox_run_args } from '../../src/sandbox.js';
import { temp_workspace } from '../helpers/harness.js';

const IMAGE = process.env['VOLLEY_SANDBOX_TEST_IMAGE'] ?? 'volley-sandbox:latest';

function docker_ready(): boolean {
  if (process.env['VOLLEY_SANDBOX_TEST'] !== '1') return false;
  if (spawnSync('docker', ['info'], { encoding: 'utf8' }).status !== 0) return false;
  return spawnSync('docker', ['image', 'inspect', IMAGE], { encoding: 'utf8' }).status === 0;
}

const RUN = docker_ready();
const HOST_UID = process.getuid?.() ?? null;
const HOST_GID = process.getgid?.() ?? null;

/** Run a raw `sh -c` script inside the hardened container over `build_root`. */
function run_in_sandbox(
  build_root: string,
  script: string,
  network: 'none' | 'allowlist',
  run_state: { root: string; run_id: string } | null = null,
): { status: number | null; stdout: string; stderr: string } {
  const args = sandbox_run_args({
    image: IMAGE,
    build_root,
    run_state,
    uid: HOST_UID,
    gid: HOST_GID,
    store_volume: 'volley-pnpm-store',
    network,
    network_name: 'volley-sandbox-net',
    entrypoint: 'sh',
    command: ['-c', script],
  });
  const res = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe.runIf(RUN)('builder sandbox (real docker run)', () => {
  it(
    'FS isolation, host-visible writes, and container cwd inside the hardened container',
    () => {
      const { workspace, cleanup } = temp_workspace();
      writeFileSync(join(workspace, 'host_seen.txt'), 'host-marker');
      const host_abs = resolve(workspace, 'host_seen.txt');
      try {
        const script = [
          'set -e',
          // Isolation: `/etc/passwd` is the *container's* file; the host path to
          // the workspace does not exist inside the container — only the
          // `/workspace` mount does. Same bytes, two views.
          'echo "PASSWD:$(head -n1 /etc/passwd)"',
          `[ -e "${host_abs}" ] && echo "HOSTABS:visible" || echo "HOSTABS:invisible"`,
          '[ -f host_seen.txt ] && echo "MOUNT:$(cat host_seen.txt)" || echo "MOUNT:missing"',
          // A container write lands host-side in the bind-mounted worktree.
          'echo container-wrote > from_container.txt',
          'echo "PWD:$(pwd)"',
        ].join('\n');
        const out = run_in_sandbox(workspace, script, 'none');
        expect(out.status).toBe(0);
        expect(out.stdout).toContain('PASSWD:root:x:0:0'); // container's /etc/passwd
        expect(out.stdout).toContain('HOSTABS:invisible'); // host path not in container
        expect(out.stdout).toContain('MOUNT:host-marker'); // bind mount visible
        expect(out.stdout).toContain('PWD:/workspace'); // -w /workspace
        // Host-side view of the container's write.
        expect(readFileSync(join(workspace, 'from_container.txt'), 'utf8')).toContain(
          'container-wrote',
        );
      } finally {
        cleanup();
      }
    },
    120_000,
  );

  it(
    "a run's state lands in its host directory, and no other run's state is in reach",
    () => {
      const { workspace, cleanup } = temp_workspace();
      // The host's root, holding another run's state the container must not see.
      const state_root = mkdtempSync(join(tmpdir(), 'volley-sandbox-state-'));
      mkdirSync(join(state_root, 'other-run'));
      writeFileSync(join(state_root, 'other-run', 'config.json'), '{"check":"true"}\n');
      // The run's own directory, created first and empty, as the host's own.
      mkdirSync(join(state_root, 'run-1'));
      try {
        const script = [
          'set -e',
          `echo probe > "${SANDBOX_STATE_ROOT}/run-1/summary.json"`,
          `ls -A "${SANDBOX_STATE_ROOT}" | tr '\\n' ' ' | sed 's/^/ROOT:/'`,
          'echo',
          `[ -e "${SANDBOX_STATE_ROOT}/other-run" ] && echo "OTHER:visible" || echo "OTHER:invisible"`,
          `mkdir "${SANDBOX_STATE_ROOT}/planted" 2>/dev/null && echo "PLANT:written" || echo "PLANT:refused"`,
        ].join('\n');
        const out = run_in_sandbox(workspace, script, 'none', { root: state_root, run_id: 'run-1' });
        expect(out.status, out.stderr).toBe(0);
        expect(readFileSync(join(state_root, 'run-1', 'summary.json'), 'utf8')).toBe('probe\n');
        expect(out.stdout).toContain('ROOT:run-1 ');
        expect(out.stdout).toContain('OTHER:invisible');
        expect(out.stdout).toContain('PLANT:refused');
        // The host's other run is untouched.
        expect(readFileSync(join(state_root, 'other-run', 'config.json'), 'utf8')).toBe(
          '{"check":"true"}\n',
        );
      } finally {
        rmSync(state_root, { recursive: true, force: true });
        cleanup();
      }
    },
    120_000,
  );

  it(
    'default-deny egress: --network none leaves the container with only loopback',
    () => {
      const { workspace, cleanup } = temp_workspace();
      try {
        // With `--network none` the container's only interface is loopback: no
        // `eth0`, so an in-container command has no path off the box.
        const out = run_in_sandbox(workspace, 'ls /sys/class/net', 'none');
        expect(out.status).toBe(0);
        expect(out.stdout).toContain('lo');
        expect(out.stdout).not.toContain('eth0');
      } finally {
        cleanup();
      }
    },
    120_000,
  );

  it(
    'cannot read the host /etc/passwd — the container has its own root filesystem',
    () => {
      const { workspace, cleanup } = temp_workspace();
      const host_passwd = readFileSync('/etc/passwd', 'utf8');
      try {
        const out = run_in_sandbox(workspace, 'cat /etc/passwd', 'none');
        expect(out.status).toBe(0);
        // A macOS host /etc/passwd carries this boilerplate; a Linux container's
        // never does — proof the read hit the container, not the host file.
        if (host_passwd.includes('# User Database')) {
          expect(out.stdout).not.toContain('# User Database');
        }
        expect(out.stdout).not.toBe(host_passwd);
      } finally {
        cleanup();
      }
    },
    120_000,
  );
});
