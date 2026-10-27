import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { aborted_error } from 'fascicle';
import type { ToolApprovalRequest } from 'fascicle';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acp_command_env } from '../../src/acp_tools.js';
import { CHECK_REJECTED } from '../../src/check/command.js';
import { load_resume_state } from '../../src/iteration.js';
import { run_volley } from '../../src/orchestrator.js';
import type { OrchestratorDeps } from '../../src/orchestrator.js';
import { silent_renderer, temp_workspace, test_config } from '../helpers/harness.js';
import { approve_reply, mock_engine, prompt_text, reject_reply } from '../helpers/mock_engine.js';

/** A stand-in checkride binary honoring the `--json` + `.check/summary.json`
 * contract: fails the `test` slot while BROKEN exists in the workspace, and
 * under `--digest` writes `.check/digest.md` on a red run and removes it on a
 * green one. */
const FAKE_CHECKRIDE = `#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
const broken = existsSync('BROKEN');
mkdirSync('.check', { recursive: true });
if (process.argv.includes('--digest')) {
  if (broken) writeFileSync('.check/digest.md', '# checkride failure digest\\n\\n## test — vitest\\n\\n- widget spins\\n');
  else rmSync('.check/digest.md', { force: true });
}
const checks = [{
  name: 'test', adapter: 'vitest', description: 'tests',
  ok: !broken, exit_code: broken ? 1 : 0, duration_ms: 42, output_file: 'test.json',
}];
const summary = { schema_version: 1, timestamp: new Date().toISOString(), ok: !broken, total_duration_ms: 42, checks };
writeFileSync('.check/summary.json', JSON.stringify(summary, null, 2));
writeFileSync('.check/test.json', JSON.stringify({ failed: broken ? 1 : 0, failing_test: broken ? 'widget spins' : null }));
process.stdout.write(JSON.stringify(summary));
process.exit(broken ? 1 : 0);
`;

/** A stand-in checkride that passes, and writes which of PATH and the seats'
 * keys it saw to `seen_env.json`. */
const ENV_CHECKRIDE = `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
const seen = ['PATH', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'].filter((name) => name in process.env);
writeFileSync('seen_env.json', JSON.stringify(seen));
mkdirSync('.check', { recursive: true });
const summary = { schema_version: 1, ok: true, total_duration_ms: 1, checks: [] };
writeFileSync('.check/summary.json', JSON.stringify(summary));
process.stdout.write(JSON.stringify(summary));
`;

function install_checkride(workspace: string, script: string): void {
  writeFileSync(
    join(workspace, 'package.json'),
    JSON.stringify({ name: 'fixture', type: 'module', scripts: { check: 'checkride' } }),
  );
  writeFileSync(join(workspace, 'checkride.config.json'), '{}');
  const bin_dir = join(workspace, 'node_modules', '.bin');
  mkdirSync(bin_dir, { recursive: true });
  const bin = join(bin_dir, 'checkride');
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
}

function setup_checkride_workspace(workspace: string): void {
  install_checkride(workspace, FAKE_CHECKRIDE);
  writeFileSync(join(workspace, 'BROKEN'), 'the test slot fails while this exists\n');
}

/** A builder that writes nothing and a critic that approves. */
function quiet_engine() {
  return mock_engine((call) =>
    call.role === 'builder' ? { content: 'done', cost_usd: 0.1 } : approve_reply(),
  );
}

describe('checkride_gate_loop', () => {
  it('iteration 1 fails the gate, critic sees the raw slot, iteration 2 passes', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      setup_checkride_workspace(workspace);
      const config = test_config({
        workspace,
        check: 'auto',
        check_resolved: 'checkride',
        max_iterations: 4,
      });

      const engine = mock_engine((call) => {
        if (call.role === 'builder') {
          const fix = prompt_text(call).includes('PREVIOUS CRITIC FEEDBACK');
          return {
            content: fix ? 'fixed the test' : 'first attempt',
            cost_usd: 0.1,
            effect: () => {
              if (fix) rmSync(join(workspace, 'BROKEN'), { force: true });
            },
          };
        }
        const failing = prompt_text(call).includes('FAILED');
        return failing ? reject_reply('the test slot fails', ['tests pass']) : approve_reply();
      });

      const result = await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });

      expect(result.status).toBe('success');
      expect(result.iterations_completed).toBe(2);

      // The builder prompt carried the checkride self-verify stanza.
      const first_builder = engine.calls.find((c) => c.role === 'builder');
      expect(prompt_text(first_builder)).toContain('pnpm check');

      // Critic 1 received the failing slot's raw artifact, not a digest.
      const first_critic = engine.calls.find((c) => c.role === 'critic');
      expect(prompt_text(first_critic)).toContain('failing slots: test');
      expect(prompt_text(first_critic)).toContain('widget spins');

      // The second builder read what the gate itself said, digest and all.
      const second_builder = engine.calls.filter((c) => c.role === 'builder')[1];
      expect(prompt_text(second_builder)).toContain('PREVIOUS CHECK RESULT');
      expect(prompt_text(second_builder)).toContain('Failing slots: test.');
      expect(prompt_text(second_builder)).toContain('## test — vitest');

      // Archived check artifacts for the failing iteration, the digest with
      // them; the green iteration has none.
      const archive = join(workspace, '.volley', 'iterations', '001', 'check');
      expect(existsSync(join(archive, 'summary.json'))).toBe(true);
      expect(existsSync(join(archive, 'test.json'))).toBe(true);
      expect(readFileSync(join(archive, 'digest.md'), 'utf8')).toContain('- widget spins');
      expect(existsSync(join(workspace, '.volley', 'iterations', '002', 'check', 'digest.md'))).toBe(false);

      const iteration_1 = JSON.parse(
        readFileSync(join(workspace, '.volley', 'iterations', '001', 'summary.json'), 'utf8'),
      ) as { check: { ok: boolean; failing_slots: string[]; runner: string } };
      expect(iteration_1.check.ok).toBe(false);
      expect(iteration_1.check.runner).toBe('checkride');
      expect(iteration_1.check.failing_slots).toEqual(['test']);
    } finally {
      cleanup();
    }
  }, 60000);
});

describe('a resumed run after a red check', () => {
  it("shows its first builder the archived check, and that the last session ran out of steps", async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      setup_checkride_workspace(workspace);
      const config = test_config({
        workspace,
        run_id: 'red-then-resumed',
        check: 'auto',
        check_resolved: 'checkride',
        max_iterations: 3,
        builder_max_steps: 12,
      });

      // Iteration 1 burns its steps and leaves the gate red; iteration 2's
      // builder is interrupted before it does anything.
      const engine_1 = mock_engine((call, index) => {
        if (call.role === 'critic') return reject_reply('the test slot fails', ['tests pass']);
        return index === 0
          ? { content: '', finish_reason: 'max_steps', cost_usd: 0.1 }
          : { content: '', error: new aborted_error('sigint') };
      });
      await expect(
        run_volley(config, { renderer: silent_renderer(), engine: engine_1, install_signal_handlers: false }),
      ).rejects.toThrow();

      const resume = load_resume_state(workspace, 'red-then-resumed');
      expect(resume.state.check?.ok).toBe(false);
      expect(resume.state.check?.digest).toContain('- widget spins');
      expect(resume.state.check?.detail[0]?.content).toContain('widget spins');
      expect(resume.state.builder?.finish_reason).toBe('max_steps');

      const engine_2 = mock_engine((call) =>
        call.role === 'builder' ? { content: 'fixed', cost_usd: 0.1 } : approve_reply(),
      );
      await run_volley(
        config,
        { renderer: silent_renderer(), engine: engine_2, install_signal_handlers: false },
        resume.state,
      );
      const resumed = prompt_text(engine_2.calls.find((c) => c.role === 'builder')).replace(/\s+/g, ' ');
      expect(resumed).toContain('ITERATION: 2');
      expect(resumed).toContain('PREVIOUS CHECK RESULT');
      expect(resumed).toContain('## test — vitest');
      expect(resumed).toContain('Your last session hit its 12-step limit');
    } finally {
      cleanup();
    }
  }, 60000);
});

describe('the check under a caller\'s gate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** One round over a checkride workspace that records what the check saw. */
  async function seen_by_checkride(deps: Pick<OrchestratorDeps, 'check'>): Promise<string[]> {
    const { workspace, cleanup } = temp_workspace();
    try {
      install_checkride(workspace, ENV_CHECKRIDE);
      vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-secret');
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-secret');
      const result = await run_volley(
        test_config({ workspace, check: 'auto', check_resolved: 'checkride', max_iterations: 1 }),
        { renderer: silent_renderer(), engine: quiet_engine(), install_signal_handlers: false, ...deps },
      );
      expect(result.status).toBe('success');
      return JSON.parse(readFileSync(join(workspace, 'seen_env.json'), 'utf8')) as string[];
    } finally {
      cleanup();
    }
  }

  it('runs checkride with the environment it is handed: PATH, and neither seat key', async () => {
    expect(await seen_by_checkride({ check: { env: acp_command_env(process.env) } })).toEqual(['PATH']);
  }, 60000);

  it("runs checkride with volley's whole environment when handed none, as on the CLI", async () => {
    expect(await seen_by_checkride({})).toEqual(['PATH', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY']);
  }, 60000);

  /** One round whose check asks first, answered by `allow`. */
  async function asked_round(allow: boolean) {
    const { workspace, cleanup } = temp_workspace();
    const requests: ToolApprovalRequest[] = [];
    const engine = quiet_engine();
    try {
      const result = await run_volley(
        test_config({ workspace, check: 'touch ran.txt', check_resolved: 'command', max_iterations: 1 }),
        {
          renderer: silent_renderer(),
          engine,
          install_signal_handlers: false,
          check: {
            on_approval: (request) => {
              requests.push(request);
              return allow;
            },
          },
        },
      );
      const round = JSON.parse(
        readFileSync(join(workspace, '.volley', 'iterations', '001', 'summary.json'), 'utf8'),
      ) as { check: { ran: boolean; ok: boolean } };
      return {
        result,
        requests,
        round,
        ran: existsSync(join(workspace, 'ran.txt')),
        critic_prompt: prompt_text(engine.calls.find((call) => call.role === 'critic')),
      };
    } finally {
      cleanup();
    }
  }

  it('asks on the check card, under its command line, before the check runs', async () => {
    const { requests, ran, result } = await asked_round(true);
    expect(requests).toEqual([
      expect.objectContaining({
        tool_name: 'touch ran.txt',
        tool_call_id: 'check',
        input: { command: 'touch ran.txt' },
      }),
    ]);
    expect(ran).toBe(true);
    expect(result.status).toBe('success');
  });

  it('records a rejected check as failed, with the refusal as its output, and never runs it', async () => {
    const { requests, ran, round, result, critic_prompt } = await asked_round(false);
    expect(requests).toHaveLength(1);
    expect(ran).toBe(false);
    expect(round.check).toMatchObject({ ran: true, ok: false });
    // The critic approved, but nothing checked the work, so the run can't converge.
    expect(result.status).toBe('budget_exhausted');
    expect(critic_prompt).toContain('result: FAILED');
    expect(critic_prompt).toContain(CHECK_REJECTED);
  });

  it('ends the run as stopped, not as a rejected check, when it is stopped while it asks', async () => {
    const { workspace, cleanup } = temp_workspace();
    const stop = new AbortController();
    try {
      const running = run_volley(
        test_config({ workspace, check: 'touch ran.txt', check_resolved: 'command', max_iterations: 1 }),
        {
          renderer: silent_renderer(),
          engine: quiet_engine(),
          install_signal_handlers: false,
          abort: stop.signal,
          check: {
            on_approval: () => {
              stop.abort();
              return false;
            },
          },
        },
      );
      await expect(running).rejects.toThrow();
      expect(existsSync(join(workspace, 'ran.txt'))).toBe(false);
      const summary = JSON.parse(readFileSync(join(workspace, '.volley', 'summary.json'), 'utf8')) as {
        status: string;
      };
      expect(summary.status).toBe('interrupted');
      // The check started, and never ended as a check, rejected or otherwise.
      const events = readFileSync(join(workspace, '.volley', 'trajectory.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { volley?: string }).volley);
      expect(events).toContain('check_start');
      expect(events).not.toContain('check_end');
    } finally {
      cleanup();
    }
  });
});
