/**
 * Opt-in Docker sandbox test (s2 Phase 2b, B′/D5): VOLLEY_SANDBOX_TEST=1 pnpm test
 *
 * Exercises the real container the B′ invocation spec produces — the hardened
 * `sandbox_run_args` argv run as a one-shot `docker run --rm` (D5/D9/D11/D12). It
 * proves the isolation done-when still holds under whole-process containment: a
 * command inside sees the *container's* root filesystem (not the host's), writes
 * land host-side in the bind-mounted worktree, and `--network none` leaves no
 * route off the box. Skipped by default: it needs a running daemon and a present
 * image, so it never gates `pnpm check`. Point it at any Linux image with `sh`
 * via VOLLEY_SANDBOX_TEST_IMAGE (default the volley image); `--entrypoint sh`
 * overrides the image's `volley` entrypoint so a raw shell script can run.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sandbox_run_args } from '../../src/sandbox.js';
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

/** Run a raw `sh -c` script inside the hardened B′ container over `build_root`. */
function run_in_sandbox(
  build_root: string,
  script: string,
  network: 'none' | 'allowlist',
): { status: number | null; stdout: string; stderr: string } {
  const args = sandbox_run_args({
    image: IMAGE,
    build_root,
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

describe.runIf(RUN)('builder sandbox (real B′ docker run)', () => {
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
          // `/workspace` mount does. Same bytes, two views (done-when).
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
    'default-deny egress: --network none leaves the container with only loopback (D6/D12)',
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
