import { describe, expect, it } from 'vitest';
import { run_volley } from '../../src/orchestrator.js';
import { exit_code_for_error } from '../../src/exit_codes.js';
import { error_kind } from '../../src/types.js';
import { silent_renderer, temp_workspace, test_config } from '../helpers/harness.js';
import { approve_reply, mock_engine } from '../helpers/mock_engine.js';

type ClaudeCliOptions = {
  allowed_tools?: string[];
  extra_args?: string[];
};

function claude_cli_options(opts: { provider_options?: Record<string, unknown> }): ClaudeCliOptions {
  return (opts.provider_options?.['claude_cli'] ?? {}) as ClaudeCliOptions;
}

/** `--settings` turns on both blocks on file tools outside the build root. */
function expect_blocks(settings: string | undefined): void {
  expect(JSON.parse(settings ?? '{}')).toEqual({
    permissions: {
      blockWritesOutsideWorkingDirectories: true,
      blockReadsOutsideWorkingDirectories: true,
    },
  });
}

describe('role permission wiring', () => {
  it('builder gets full tools + permission mode; critic is read-only with a schema', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({ workspace, builder_permission_mode: 'bypassPermissions' });
      const engine = mock_engine((call) =>
        call.role === 'builder' ? { content: 'done', cost_usd: 0.1 } : approve_reply(),
      );
      await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });

      const builder = engine.calls.find((c) => c.role === 'builder');
      const builder_cli = claude_cli_options(builder!.opts);
      expect(builder_cli.allowed_tools).toContain('Bash');
      // File tools only through path rules scoped to the build root: a bare
      // entry would approve every path on the machine.
      expect(builder_cli.allowed_tools).toContain('Edit(/**)');
      expect(builder_cli.allowed_tools).toContain('Read(/**)');
      for (const bare of ['Read', 'Write', 'Edit', 'MultiEdit', 'Grep', 'Glob']) {
        expect(builder_cli.allowed_tools).not.toContain(bare);
      }
      expect(builder_cli.extra_args?.slice(0, 3)).toEqual([
        '--permission-mode',
        'bypassPermissions',
        '--settings',
      ]);
      expect_blocks(builder_cli.extra_args?.[3]);
      expect(builder!.opts.schema).toBeUndefined();

      const critic = engine.calls.find((c) => c.role === 'critic');
      const critic_cli = claude_cli_options(critic!.opts);
      expect(critic_cli.allowed_tools).toEqual(['Read(/**)']);
      expect(critic_cli.extra_args?.slice(0, 3)).toEqual([
        '--disallowedTools',
        'Write,Edit,MultiEdit,NotebookEdit,Bash',
        '--settings',
      ]);
      expect_blocks(critic_cli.extra_args?.[3]);
      expect(critic!.opts.schema).toBeDefined();
      expect(critic!.opts.system).toContain('read-only access');
      // Fresh context per iteration: no session_id continuation, ever.
      for (const call of engine.calls) {
        expect((call.opts.provider_options?.['claude_cli'] as Record<string, unknown>)?.['session_id']).toBeUndefined();
      }
    } finally {
      cleanup();
    }
  });
});

describe('check pipeline failures', () => {
  it('a check command that cannot start maps to exit 4', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({
        workspace,
        check: 'definitely_not_a_real_binary_xyz',
        check_resolved: 'command',
      });
      const engine = mock_engine((call) =>
        call.role === 'builder' ? { content: 'done', cost_usd: 0.1 } : approve_reply(),
      );
      let thrown: unknown = null;
      try {
        await run_volley(config, {
          renderer: silent_renderer(),
          engine,
          install_signal_handlers: false,
        });
      } catch (err) {
        thrown = err;
      }
      expect(error_kind(thrown)).toBe('check_error');
      expect(exit_code_for_error(thrown)).toBe(4);
    } finally {
      cleanup();
    }
  });

  it('a failing (but working) check command iterates instead of erroring', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({
        workspace,
        check: 'test -f never_written.txt',
        check_resolved: 'command',
        max_iterations: 2,
      });
      const engine = mock_engine((call) =>
        call.role === 'builder' ? { content: 'tried', cost_usd: 0.1 } : approve_reply(),
      );
      const result = await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });
      // Critic approves but the check gate holds: budget exhaustion, not error.
      expect(result.status).toBe('budget_exhausted');
      expect(engine.calls.filter((c) => c.role === 'critic')).toHaveLength(2);
    } finally {
      cleanup();
    }
  });
});
