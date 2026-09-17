import { describe, expect, it } from 'vitest';
import {
  format_docker_run,
  HOST_GATEWAY_HOST,
  network_run_args,
  sandbox_invocation,
  SANDBOX_NETWORK_NAME,
  SANDBOX_NETWORK_SUBNET,
  sandbox_run_args,
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
    network: 'none',
    network_name: 'volley-sandbox-net',
    ...overrides,
  });
}

describe('sandbox_run_args (the invocation spec; hardening flag set)', () => {
  it('is a one-shot foreground --rm container, no daemon keep-alive (no -d … sleep infinity)', () => {
    const args = run_args();
    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
    expect(args).not.toContain('-d');
    expect(args.join(' ')).not.toContain('sleep infinity');
    expect(args[args.indexOf('--name') + 1]).toBe('volley-sandbox-run-1');
    // The image is the last argv when no command is appended.
    expect(args[args.length - 1]).toBe('volley-sandbox:latest');
    // The host build root is bind-mounted and is the container cwd.
    expect(args).toContain('/tmp/ws.worktree:/workspace');
    expect(args[args.indexOf('-w') + 1]).toBe('/workspace');
  });

  it('appends the volley command after the image and injects env / entrypoint (the host crossing)', () => {
    const args = run_args({
      command: ['--prompt', 'do the thing', '--workspace', '/workspace'],
      env: [['VOLLEY_MODEL_HOST', HOST_GATEWAY_HOST]],
      entrypoint: 'sh',
    });
    // Command trails the image; the image immediately precedes it.
    expect(args.slice(-4)).toEqual(['--prompt', 'do the thing', '--workspace', '/workspace']);
    expect(args[args.length - 5]).toBe('volley-sandbox:latest');
    // Env injection and entrypoint override.
    const joined = args.join(' ');
    expect(joined).toContain(`-e VOLLEY_MODEL_HOST=${HOST_GATEWAY_HOST}`);
    expect(args[args.indexOf('--entrypoint') + 1]).toBe('sh');
    // The entrypoint override sits before the image.
    expect(args.indexOf('--entrypoint')).toBeLessThan(args.lastIndexOf('volley-sandbox:latest'));
  });

  it('applies the hardening caps: non-root user, cap-drop, no-new-privileges, init, resource limits, read-only + tmpfs', () => {
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

  it('never grants root or full privileges', () => {
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

  it('omits --name when none is given (the operator/example names the container)', () => {
    expect(run_args({ name: null })).not.toContain('--name');
  });

  it('carries the network posture into the run argv', () => {
    // Default-deny: no interface at all.
    expect(run_args({ network: 'none' }).join(' ')).toContain('--network none');
    // Allowlist: user-defined bridge + host-collapsed allowlist via host-gateway.
    const allow = run_args({ network: 'allowlist' });
    expect(allow[allow.indexOf('--network') + 1]).toBe('volley-sandbox-net');
    expect(allow[allow.indexOf('--add-host') + 1]).toBe(`${HOST_GATEWAY_HOST}:host-gateway`);
  });
});

describe('network_run_args (egress postures)', () => {
  it("'none' denies all egress with --network none and no host-gateway", () => {
    const args = network_run_args('none', 'volley-sandbox-net');
    expect(args).toEqual(['--network', 'none']);
    expect(args).not.toContain('--add-host');
  });

  it("'allowlist' attaches the user-defined bridge and collapses the allowlist onto the host gateway", () => {
    expect(network_run_args('allowlist', 'volley-sandbox-net')).toEqual([
      '--network',
      'volley-sandbox-net',
      '--add-host',
      `${HOST_GATEWAY_HOST}:host-gateway`,
    ]);
  });
});

describe('sandbox_invocation (the invocation-spec helper)', () => {
  it('composes the hardened run with the canonical bridge + pnpm store and the volley command', () => {
    const args = sandbox_invocation({
      image: 'volley-sandbox:latest',
      build_root: '/tmp/ws.worktree',
      uid: 501,
      gid: 20,
      network: 'none',
      command: ['--prompt', 'p', '--workspace', '/workspace'],
    });
    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
    expect(args).toContain('/tmp/ws.worktree:/workspace');
    expect(args.join(' ')).toContain('volley-pnpm-store:/home/node/.local/share/pnpm/store');
    expect(args.slice(-4)).toEqual(['--prompt', 'p', '--workspace', '/workspace']);
    // No crossing env when no host model is targeted (fully-offline shape).
    expect(args.join(' ')).not.toContain('VOLLEY_MODEL_HOST');
  });

  it('injects VOLLEY_MODEL_HOST on the allowlist crossing and uses the canonical bridge', () => {
    const args = sandbox_invocation({
      image: 'volley-sandbox:latest',
      build_root: '/tmp/ws.worktree',
      uid: 501,
      gid: 20,
      network: 'allowlist',
      model_host: HOST_GATEWAY_HOST,
      command: ['--prompt', 'p'],
    });
    expect(args[args.indexOf('--network') + 1]).toBe(SANDBOX_NETWORK_NAME);
    expect(args.join(' ')).toContain(`-e VOLLEY_MODEL_HOST=${HOST_GATEWAY_HOST}`);
  });
});

describe('allowlist bridge identity (the invocation spec the examples share)', () => {
  it('names the dedicated user-defined bridge and its pinned /24 subnet', () => {
    expect(SANDBOX_NETWORK_NAME).toBe('volley-sandbox-net');
    expect(SANDBOX_NETWORK_SUBNET).toBe('172.31.99.0/24');
    // The subnet the host `DOCKER-USER` default-DROP rules scope to is a /24.
    expect(SANDBOX_NETWORK_SUBNET.endsWith('/24')).toBe(true);
  });
});

describe('format_docker_run (copy-paste shell line for examples / --dry-run)', () => {
  it('prefixes docker and single-quotes only tokens with whitespace/specials', () => {
    const line = format_docker_run(run_args({ command: ['--prompt', 'build a thing'] }));
    expect(line.startsWith('docker run --rm')).toBe(true);
    expect(line).toContain('volley-sandbox:latest');
    // A plain flag stays bare; an arg with a space is quoted.
    expect(line).toContain('--prompt');
    expect(line).toContain("'build a thing'");
  });
});
