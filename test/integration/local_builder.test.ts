import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILDER_ALLOWED_TOOLS, compose_builder_system } from '../../src/builder.js';
import { run_volley } from '../../src/orchestrator.js';
import { silent_renderer, temp_workspace, test_config } from '../helpers/harness.js';
import { mock_engine } from '../helpers/mock_engine.js';

const BUILDER_TOOL_NAMES = [
  'read_file',
  'search_files',
  'list_files',
  'write_file',
  'edit_file',
  'bash',
  'fetch',
  'finish',
];

describe('local builder (ollama provider)', () => {
  it('routes the builder to the local provider with the tool loop, not the CLI allowlist', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({
        workspace,
        builder_provider: 'ollama',
        builder_model: 'qwen3-coder:30b',
        builder_max_steps: 17,
        allow_unsandboxed_builder: true,
        max_iterations: 2,
      });
      // The local builder produces a workspace via its tool loop; the mock
      // stands in for that loop by writing the file as its effect.
      const engine = mock_engine((call) =>
        call.role === 'builder'
          ? {
              content: 'built',
              // Local free providers report zero cost, not undefined.
              cost_usd: 0,
              effect: () => writeFileSync(join(workspace, 'out.txt'), 'done'),
            }
          : { content: { verdict: 'approved', feedback: 'ok', unmet_criteria: [] }, cost_usd: 0.05 },
      );

      const result = await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });

      // The produced workspace runs check + critic to success, exactly like a
      // claude_cli build.
      expect(result.status).toBe('success');

      const builder = engine.calls.find((c) => c.role === 'builder');
      expect(builder?.opts.provider).toBe('ollama');
      expect(builder?.opts.model).toBe('qwen3-coder:30b');

      // The whole volley tool surface is supplied, in the reused-read-tools +
      // new-tools order, terminated by `finish`.
      expect(builder?.opts.tools?.map((t) => t.name)).toEqual(BUILDER_TOOL_NAMES);
      // `finish` is the terminal tool: a successful call ends the loop (D6).
      const finish = builder?.opts.tools?.find((t) => t.name === 'finish');
      expect(finish?.ends_turn).toBe(true);

      // The five per-call loop knobs (D5/C5) — and no schema (a builder
      // produces a workspace, not a verdict).
      expect(builder?.opts.max_steps).toBe(17);
      expect(builder?.opts.tool_error_policy).toBe('feed_back');
      expect(builder?.opts.tool_call_repair_attempts).toBeGreaterThan(0);
      expect(builder?.opts.max_tool_calls_per_step).toBe(1);
      expect(builder?.opts.schema).toBeUndefined();

      // No claude_cli allowlist plumbing on the local arm.
      expect(builder?.opts.provider_options).toBeUndefined();

      // The local system prompt names the volley tools and the finish stop,
      // not the CLI builder's implicit-cwd wording.
      expect(builder?.opts.system).toContain('write_file(path, content)');
      expect(builder?.opts.system).toContain('finish(summary)');
      expect(builder?.opts.system).not.toBe(compose_builder_system());

      // The critic still runs on claude_cli — only the builder moved.
      const critic = engine.calls.find((c) => c.role === 'critic');
      expect(critic?.opts.provider).toBe('claude_cli');
    } finally {
      cleanup();
    }
  });

  it('leaves the claude_cli builder arm byte-for-byte unchanged (C3, §8 fairness)', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      // Default builder_provider is claude_cli; the critic goes local so the
      // only claude_cli call in the run is the builder under test.
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
          : { content: { verdict: 'approved', feedback: 'ok', unmet_criteria: [] }, cost_usd: 0 },
      );

      const result = await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });

      expect(result.status).toBe('success');

      const builder = engine.calls.find((c) => c.role === 'builder');
      expect(builder?.opts.provider).toBe('claude_cli');
      expect(builder?.opts.model).toBe(config.builder_model);
      // The v2 CLI builder prompt, unchanged.
      expect(builder?.opts.system).toBe(compose_builder_system());
      // The v2 CLI confinement: allowlist + permission mode, nothing else.
      expect(builder?.opts.provider_options).toEqual({
        claude_cli: {
          allowed_tools: [...BUILDER_ALLOWED_TOOLS],
          extra_args: ['--permission-mode', config.builder_permission_mode],
        },
      });
      // None of the local tool-loop knobs leak onto the CLI arm.
      expect(builder?.opts.tools).toBeUndefined();
      expect(builder?.opts.max_steps).toBeUndefined();
      expect(builder?.opts.tool_error_policy).toBeUndefined();
      expect(builder?.opts.tool_call_repair_attempts).toBeUndefined();
      expect(builder?.opts.max_tool_calls_per_step).toBeUndefined();
      expect(builder?.opts.schema).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
