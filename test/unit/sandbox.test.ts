import { describe, expect, it } from 'vitest';
import type { BashExecutor } from '../../src/builder/tools.js';
import {
  sandbox_container_name,
  sandbox_run_args,
  with_sandbox,
} from '../../src/sandbox.js';
import { error_kind } from '../../src/types.js';

function run_args(overrides: Partial<Parameters<typeof sandbox_run_args>[0]> = {}): string[] {
  return sandbox_run_args({
    image: 'volley-sandbox:latest',
    build_root: '/tmp/ws.worktree',
    name: 'volley-sandbox-run-1',
    uid: 501,
    gid: 20,
    store_volume: 'volley-pnpm-store',
    ...overrides,
  });
}

describe('sandbox_run_args (D9/D11 hardening flag set)', () => {
  it('starts a detached, named, long-lived container bind-mounting the build root at /workspace', () => {
    const args = run_args();
    expect(args.slice(0, 2)).toEqual(['run', '-d']);
    expect(args[args.indexOf('--name') + 1]).toBe('volley-sandbox-run-1');
    // The keep-alive command is the last argv, the image just before it (D9).
    expect(args.slice(-2)).toEqual(['sleep', 'infinity']);
    expect(args[args.length - 3]).toBe('volley-sandbox:latest');
    // Shape B: the host build root is bind-mounted and is the container cwd.
    expect(args).toContain('/tmp/ws.worktree:/workspace');
    expect(args[args.indexOf('-w') + 1]).toBe('/workspace');
  });

  it('applies the D11 caps: non-root user, cap-drop, no-new-privileges, init, resource limits, read-only + tmpfs', () => {
    const args = run_args();
    const joined = args.join(' ');
    expect(args[args.indexOf('--user') + 1]).toBe('501:20');
    expect(args).toContain('--cap-drop=ALL');
    expect(args[args.indexOf('--security-opt') + 1]).toBe('no-new-privileges');
    expect(args).toContain('--init');
    expect(args).toContain('--memory=4g');
    expect(args).toContain('--memory-swap=4g');
    expect(args).toContain('--cpus=2');
    expect(args).toContain('--pids-limit=1024');
    expect(joined).toContain('--ulimit nofile=8192:16384');
    expect(joined).toContain('--ulimit core=0');
    // Read-only rootfs with tmpfs for the writable paths, pnpm store on a volume.
    expect(args).toContain('--read-only');
    expect(joined).toContain('--tmpfs /tmp');
    expect(joined).toContain('--tmpfs /run');
    expect(joined).toContain('volley-pnpm-store:/home/node/.local/share/pnpm/store');
  });

  it('never grants root or full privileges (D9)', () => {
    const args = run_args();
    expect(args).not.toContain('--privileged');
    expect(args[args.indexOf('--user') + 1]).not.toBe('0:0');
    let caught: unknown;
    try {
      run_args({ uid: 0 });
    } catch (err) {
      caught = err;
    }
    expect(error_kind(caught)).toBe('config_error');
  });

  it('omits --user when the host uid is unavailable (falls back to the image non-root user)', () => {
    expect(run_args({ uid: null, gid: null })).not.toContain('--user');
  });
});

describe('sandbox_container_name', () => {
  it('derives a valid, run-unique docker name from the run id', () => {
    expect(sandbox_container_name('abc-123')).toBe('volley-sandbox-abc-123');
  });
});

describe('with_sandbox (disabled pass-through)', () => {
  it('hands the body a null executor and never touches Docker when disabled', async () => {
    let received: BashExecutor | null | 'unset' = 'unset';
    const out = await with_sandbox(
      { enabled: false, image: 'x', build_root: '/tmp', run_id: 'r' },
      async (executor) => {
        received = executor;
        return 42;
      },
    );
    expect(out).toBe(42);
    expect(received).toBeNull();
  });
});
