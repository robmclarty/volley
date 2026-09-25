import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { run_volley } from '../../src/orchestrator.js';
import { silent_renderer, temp_workspace, test_config } from '../helpers/harness.js';
import { mock_engine } from '../helpers/mock_engine.js';

describe('local critic (ollama provider)', () => {
  it('routes the critic to the local provider with workspace tools, not CLI allowlist', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({
        workspace,
        critic_provider: 'ollama',
        critic_model: 'qwen3:32b',
        max_iterations: 2,
      });
      const engine = mock_engine((call) =>
        call.role === 'builder'
          ? {
              content: 'built',
              cost_usd: 0.2,
              effect: () => writeFileSync(join(workspace, 'out.txt'), 'done'),
            }
          : // Local free providers report zero cost, not undefined.
            { content: { verdict: 'approved', feedback: 'ok', unmet_criteria: [] }, cost_usd: 0 },
      );

      const result = await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });

      expect(result.status).toBe('success');

      const critic = engine.calls.find((c) => c.role === 'critic');
      expect(critic?.opts.provider).toBe('ollama');
      expect(critic?.opts.model).toBe('qwen3:32b');
      // Read-only tools are supplied; no claude_cli allowlist plumbing.
      expect(critic?.opts.tools?.map((t) => t.name)).toEqual([
        'read_file',
        'search_files',
        'list_files',
      ]);
      expect(critic?.opts.provider_options).toBeUndefined();
      expect(critic?.opts.schema).toBeDefined();
      // The critic system prompt names the local tools, not Read/Grep/Glob.
      expect(critic?.opts.system).toContain('read_file(path)');
      expect(critic?.opts.system).not.toContain('(Read, Grep, Glob)');

      // The builder still runs on claude_cli.
      const builder = engine.calls.find((c) => c.role === 'builder');
      expect(builder?.opts.provider).toBe('claude_cli');

      // Zero-cost critic keeps the run cost accurate and un-warned.
      const iteration = JSON.parse(
        readFileSync(join(workspace, '.volley', 'iterations', '001', 'summary.json'), 'utf8'),
      ) as { critic: { cost_usd: number; cost_source: string; provider: string } };
      expect(iteration.critic.provider).toBe('ollama');
      expect(iteration.critic.cost_usd).toBe(0);
      expect(iteration.critic.cost_source).toBe('engine_derived');
      expect(result.builder_cost_usd).toBeCloseTo(0.2);
      expect(result.critic_cost_usd).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('archives each phase\'s wall-clock from volley\'s stopwatch, which no local provider reports', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({
        workspace,
        critic_provider: 'ollama',
        critic_model: 'qwen3:32b',
        max_iterations: 1,
      });
      const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));
      const engine = mock_engine((call) =>
        call.role === 'builder'
          ? // The mock's claude_cli payload claims 1234 ms; volley must not use it.
            { content: 'built', cost_usd: 0.2, effect: pause }
          : {
              content: { verdict: 'approved', feedback: 'ok', unmet_criteria: [] },
              cost_usd: 0,
              effect: pause,
            },
      );

      await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });

      const iteration = JSON.parse(
        readFileSync(join(workspace, '.volley', 'iterations', '001', 'summary.json'), 'utf8'),
      ) as { builder: { duration_ms: number }; critic: { duration_ms: number; provider: string } };
      expect(iteration.critic.provider).toBe('ollama');
      expect(iteration.critic.duration_ms).toBeGreaterThanOrEqual(25);
      expect(iteration.builder.duration_ms).toBeGreaterThanOrEqual(25);
      expect(iteration.builder.duration_ms).toBeLessThan(1234);
    } finally {
      cleanup();
    }
  });
});
