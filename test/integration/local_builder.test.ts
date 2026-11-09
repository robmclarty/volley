import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StepRecord, ToolCallRecord } from 'fascicle';
import { compose_builder_system } from '../../src/builder.js';
import { BUILDER_ALLOWED_TOOLS, settings_args } from '../../src/claude_cli_permissions.js';
import { run_volley } from '../../src/orchestrator.js';
import type { Renderer } from '../../src/render/renderer.js';
import { silent_renderer, temp_workspace, test_config } from '../helpers/harness.js';
import { approve_reply, mock_engine, reject_reply } from '../helpers/mock_engine.js';

// The injected engine answers every model call, but the Ollama prewarm and
// context probe still make real requests. Point them at a closed port so these
// tests never reach a developer's own Ollama, where a cold load can stall them.
beforeEach(() => {
  vi.stubEnv('VOLLEY_OLLAMA_URL', 'http://127.0.0.1:1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A renderer that captures `warn` lines (the max_steps notice) and no-ops the
 * rest, so a test can assert what the run surfaced. */
function capturing_renderer(): { renderer: Renderer; warnings: string[] } {
  const warnings: string[] = [];
  return { renderer: { ...silent_renderer(), warn: (m) => warnings.push(m) }, warnings };
}

/** A minimal executed tool call for the salvage-rate metric; `salvaged: true`
 * marks one recovered from assistant text. */
function tool_call(name: string, salvaged?: true): ToolCallRecord {
  return { id: `${name}-1`, name, input: {}, duration_ms: 1, started_at: 0, ...(salvaged ? { salvaged } : {}) };
}

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
      // `finish` is the terminal tool: a successful call ends the loop.
      const finish = builder?.opts.tools?.find((t) => t.name === 'finish');
      expect(finish?.ends_turn).toBe(true);

      // The five per-call loop knobs — and no schema (a builder
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

  it('hands a raised tool-call cap to the call, and words the prompt for batched reads', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({
        workspace,
        builder_provider: 'ollama',
        builder_model: 'qwen3.8:27b',
        builder_max_tool_calls: 4,
        allow_unsandboxed_builder: true,
        max_iterations: 1,
      });
      const engine = mock_engine((call) =>
        call.role === 'builder'
          ? { content: 'built', cost_usd: 0 }
          : { content: { verdict: 'approved', feedback: 'ok', unmet_criteria: [] }, cost_usd: 0 },
      );
      await run_volley(config, { renderer: silent_renderer(), engine, install_signal_handlers: false });

      const builder = engine.calls.find((c) => c.role === 'builder');
      expect(builder?.opts.max_tool_calls_per_step).toBe(4);
      expect(String(builder?.opts.system).replace(/\s+/g, ' ')).toContain(
        'Batch independent reads into one turn, but make one change or command per turn',
      );
    } finally {
      cleanup();
    }
  });

  it('treats a max_steps cutoff as data, not an error: warns, records finish_reason + salvage rate, and still runs check + critic', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({
        workspace,
        builder_provider: 'ollama',
        builder_model: 'qwen3-coder:30b',
        builder_max_steps: 8,
        allow_unsandboxed_builder: true,
        check: 'true',
        check_resolved: 'command',
        max_iterations: 1,
      });
      // The builder burns its whole step budget without calling finish: a
      // max_steps cutoff, three tool calls, two of them salvaged from assistant
      // text. It leaves a partial workspace behind.
      const engine = mock_engine((call) =>
        call.role === 'builder'
          ? {
              content: 'partial work',
              cost_usd: 0,
              finish_reason: 'max_steps',
              tool_calls: [tool_call('write_file', true), tool_call('bash'), tool_call('edit_file', true)],
              effect: () => writeFileSync(join(workspace, 'out.txt'), 'partial'),
            }
          : {
              content: { verdict: 'changes_requested', feedback: 'still incomplete', unmet_criteria: ['done'] },
              cost_usd: 0,
            },
      );

      const { renderer, warnings } = capturing_renderer();
      const result = await run_volley(config, { renderer, engine, install_signal_handlers: false });

      // Not an error: the partial workspace went through check + critic and the
      // single-iteration run ended normally (the critic wanted changes).
      expect(result.status).toBe('budget_exhausted');
      expect(engine.calls.some((c) => c.role === 'critic')).toBe(true);

      // The cutoff surfaced as a renderer warning naming the step limit, and
      // is counted where `--json` and the run summary carry it.
      expect(warnings.some((w) => w.includes('8-step limit'))).toBe(true);
      expect(result.builder_max_steps_hits).toBe(1);
      const run_summary = JSON.parse(readFileSync(join(workspace, '.volley', 'summary.json'), 'utf8'));
      expect(run_summary.builder_max_steps_hits).toBe(1);

      const summary = JSON.parse(
        readFileSync(join(workspace, '.volley', 'iterations', '001', 'summary.json'), 'utf8'),
      );
      // Check ran on the partial workspace; the critic critiqued it.
      expect(summary.check.ran).toBe(true);
      expect(summary.verdict).toBe('changes_requested');
      // finish_reason + the salvage-rate health metric are recorded.
      expect(summary.builder.finish_reason).toBe('max_steps');
      expect(summary.builder.tool_calls).toBe(3);
      expect(summary.builder.salvaged_tool_calls).toBe(2);
      expect(summary.builder.salvage_rate).toBeCloseTo(2 / 3);
    } finally {
      cleanup();
    }
  });

  it('logs the finish summary to the trajectory and records finish_reason: stop with no cutoff warning', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({
        workspace,
        builder_provider: 'ollama',
        builder_model: 'qwen3-coder:30b',
        allow_unsandboxed_builder: true,
        max_iterations: 1,
      });
      const finish_summary = 'created out.txt and verified pnpm check';
      // The mock stands in for the real fascicle tool loop (just as its
      // file-writing effect does): a successful `finish` ends the turn, and
      // fascicle records the call to the trajectory like any tool call.
      const engine = mock_engine((call) =>
        call.role === 'builder'
          ? {
              content: 'done',
              cost_usd: 0,
              finish_reason: 'stop',
              effect: (opts) => {
                writeFileSync(join(workspace, 'out.txt'), 'done');
                opts.trajectory?.record({
                  kind: 'tool_result',
                  name: 'finish',
                  output: `finished: ${finish_summary}`,
                });
              },
            }
          : { content: { verdict: 'approved', feedback: 'ok', unmet_criteria: [] }, cost_usd: 0 },
      );

      const { renderer, warnings } = capturing_renderer();
      const result = await run_volley(config, { renderer, engine, install_signal_handlers: false });

      expect(result.status).toBe('success');
      // A clean finish is not a max_steps cutoff — no warning, no count.
      expect(warnings.some((w) => w.includes('step limit'))).toBe(false);
      expect(result.builder_max_steps_hits).toBe(0);

      const summary = JSON.parse(
        readFileSync(join(workspace, '.volley', 'iterations', '001', 'summary.json'), 'utf8'),
      );
      expect(summary.builder.finish_reason).toBe('stop');
      expect(summary.builder.salvage_rate).toBe(0);

      // The finish summary reached the durable trajectory record.
      const trajectory = readFileSync(join(workspace, '.volley', 'trajectory.jsonl'), 'utf8');
      expect(trajectory).toContain(finish_summary);
    } finally {
      cleanup();
    }
  });

  it("archives each builder turn's request size, timing split, and tool output sizes", async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({
        workspace,
        builder_provider: 'ollama',
        builder_model: 'qwen3-coder:30b',
        allow_unsandboxed_builder: true,
        max_iterations: 1,
      });
      const turn = (index: number, input_tokens: number): StepRecord => ({
        index,
        text: '',
        tool_calls: [
          { id: `c${String(index)}`, name: 'read_file', input: { path: 'a.ts' }, output: 'x'.repeat(40), duration_ms: 1, started_at: 0 },
        ],
        usage: { input_tokens, output_tokens: 30 },
        timing: { started_at: 0, duration_ms: 4000, first_chunk_ms: 1000 },
        finish_reason: 'tool_calls',
        provider_reported: { ollama: { total_duration: 4e9, load_duration: 0, eval_duration: 2.5e9 } },
      });
      const engine = mock_engine((call) =>
        call.role === 'builder'
          ? { content: 'done', cost_usd: 0, steps: [turn(0, 2600), turn(1, 3900)] }
          : { content: { verdict: 'approved', feedback: 'ok', unmet_criteria: [] }, cost_usd: 0 },
      );

      await run_volley(config, { renderer: silent_renderer(), engine, install_signal_handlers: false });

      const summary = JSON.parse(
        readFileSync(join(workspace, '.volley', 'iterations', '001', 'summary.json'), 'utf8'),
      );
      expect(summary.builder.steps).toEqual([
        {
          index: 0,
          input_tokens: 2600,
          output_tokens: 30,
          duration_ms: 4000,
          prefill_ms: 1500,
          decode_ms: 2500,
          timing_basis: 'ollama_derived',
          finish_reason: 'tool_calls',
          tool_calls: [{ name: 'read_file', output_chars: 40 }],
        },
        expect.objectContaining({ index: 1, input_tokens: 3900 }),
      ]);
      expect(summary.critic).not.toHaveProperty('steps');
    } finally {
      cleanup();
    }
  });

  it('never trips the max_cost_usd cap on $0 local phases and keeps totals accurate', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({
        workspace,
        builder_provider: 'ollama',
        builder_model: 'qwen3-coder:30b',
        allow_unsandboxed_builder: true,
        max_cost_usd: 1,
        max_iterations: 2,
      });
      // All-local, all-free run under a cap. Both iterations must run in
      // full: with `>=` in the cap predicate, a $0 build must neither halt
      // the loop nor short-circuit check + critic via the crossed-cap guard.
      const engine = mock_engine((call, index) =>
        call.role === 'builder'
          ? {
              content: 'built',
              cost_usd: 0,
              effect: () => writeFileSync(join(workspace, 'out.txt'), `iter ${String(index)}`),
            }
          : index === 1
            ? { content: { verdict: 'changes_requested', feedback: 'more', unmet_criteria: ['done'] }, cost_usd: 0 }
            : { content: { verdict: 'approved', feedback: 'ok', unmet_criteria: [] }, cost_usd: 0 },
      );

      const { renderer, warnings } = capturing_renderer();
      const result = await run_volley(config, { renderer, engine, install_signal_handlers: false });

      // Two full iterations ran to success — not 'cost_cap_reached'.
      expect(result.status).toBe('success');
      expect(result.iterations_completed).toBe(2);
      expect(engine.calls.filter((c) => c.role === 'critic')).toHaveLength(2);

      // Totals are accurate, not polluted by null-fallbacks.
      expect(result.total_cost_usd).toBe(0);
      expect(result.builder_cost_usd).toBe(0);
      expect(result.critic_cost_usd).toBe(0);

      // $0 is a real engine-derived price, not an unknown one — no warning.
      expect(warnings.some((w) => w.includes('cost unavailable'))).toBe(false);

      const summary = JSON.parse(
        readFileSync(join(workspace, '.volley', 'iterations', '001', 'summary.json'), 'utf8'),
      );
      expect(summary.builder.cost_usd).toBe(0);
      expect(summary.builder.cost_source).toBe('engine_derived');
      expect(summary.builder.provider).toBe('ollama');
    } finally {
      cleanup();
    }
  });

  it('leaves the claude_cli builder arm byte-for-byte unchanged', async () => {
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
      // The CLI confinement: allowlist, permission mode, and the settings
      // blocks, nothing else.
      expect(builder?.opts.provider_options).toEqual({
        claude_cli: {
          allowed_tools: [...BUILDER_ALLOWED_TOOLS],
          extra_args: ['--permission-mode', config.builder_permission_mode, ...settings_args()],
        },
      });
      // None of the local tool-loop knobs leak onto the CLI arm.
      expect(builder?.opts.tools).toBeUndefined();
      expect(builder?.opts.max_steps).toBeUndefined();
      expect(builder?.opts.tool_error_policy).toBeUndefined();
      expect(builder?.opts.tool_call_repair_attempts).toBeUndefined();
      expect(builder?.opts.max_tool_calls_per_step).toBeUndefined();
      expect(builder?.opts.schema).toBeUndefined();
      // No ladder and no critic effort: neither seat is sent an effort.
      for (const call of engine.calls) expect(call.opts).not.toHaveProperty('effort');
    } finally {
      cleanup();
    }
  });

  it('adds only the effort to either seat when a ladder is set, and nothing else', async () => {
    /** Both seats' call options from a one-round all-Claude run on `config`. */
    async function seat_options(overrides: Parameters<typeof test_config>[0]) {
      const engine = mock_engine((call) =>
        call.role === 'builder' ? { content: 'built', cost_usd: 0.1 } : approve_reply(),
      );
      const result = await run_volley(test_config(overrides), {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });
      expect(result.status).toBe('success');
      const builder = engine.calls.find((c) => c.role === 'builder')!.opts;
      const critic = engine.calls.find((c) => c.role === 'critic')!.opts;
      return { builder, critic };
    }
    const { workspace, cleanup } = temp_workspace();
    try {
      const plain = await seat_options({ workspace, run_id: 'plain' });
      const laddered = await seat_options({
        workspace,
        run_id: 'laddered',
        effort_ladder: ['low', 'high'],
        critic_effort: 'xhigh',
      });
      expect(laddered.builder.effort).toBe('low');
      expect(laddered.critic.effort).toBe('xhigh');
      for (const seat of ['builder', 'critic'] as const) {
        expect(Object.keys(laddered[seat]).toSorted()).toEqual(
          [...Object.keys(plain[seat]), 'effort'].toSorted(),
        );
        expect(laddered[seat].provider_options).toEqual(plain[seat].provider_options);
        expect(laddered[seat].system).toBe(plain[seat].system);
        expect(laddered[seat].model).toBe(plain[seat].model);
      }
    } finally {
      cleanup();
    }
  });
});

describe('the effort ladder', () => {
  it('climbs one rung per build that did not end the run, the top rung repeating', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({
        workspace,
        max_iterations: 5,
        effort_ladder: ['low', 'medium', 'high'],
        critic_effort: 'high',
      });
      // Rejected four times, approved on the fifth build.
      let critiques = 0;
      const engine = mock_engine((call) => {
        if (call.role === 'builder') return { content: 'built', cost_usd: 0.1 };
        critiques += 1;
        return critiques < 5 ? reject_reply('not yet') : approve_reply();
      });
      const rung_lines: string[] = [];
      const renderer: Renderer = {
        ...silent_renderer(),
        rung: (iteration, rung, climbed) => rung_lines.push(`${String(iteration)} ${rung} ${String(climbed)}`),
      };
      const result = await run_volley(config, { renderer, engine, install_signal_handlers: false });
      expect(result.status).toBe('success');
      // One rung line a build, as the build opens.
      expect(rung_lines).toEqual([
        '1 low null',
        '2 medium critic_rejected',
        '3 high critic_rejected',
        '4 high null',
        '5 high null',
      ]);
      const builds = engine.calls.filter((c) => c.role === 'builder').map((c) => c.opts.effort);
      // Build k runs at ladder[min(k, len) - 1].
      expect(builds).toEqual(['low', 'medium', 'high', 'high', 'high']);
      const critics = engine.calls.filter((c) => c.role === 'critic').map((c) => c.opts.effort);
      expect(critics).toEqual(['high', 'high', 'high', 'high', 'high']);

      const archived = [1, 2, 3, 4, 5].map(
        (n) =>
          JSON.parse(
            readFileSync(join(workspace, '.volley', 'iterations', String(n).padStart(3, '0'), 'summary.json'), 'utf8'),
          ) as Record<string, unknown>,
      );
      expect(archived.map((it) => it['builds'])).toEqual([1, 2, 3, 4, 5]);
      expect(archived.map((it) => it['rung'])).toEqual(['low', 'medium', 'high', 'high', 'high']);
      expect(archived.map((it) => it['climbed'])).toEqual([
        null,
        'critic_rejected',
        'critic_rejected',
        null,
        null,
      ]);
    } finally {
      cleanup();
    }
  });

  it('names a failed check as the reason it climbed, before the critic', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({
        workspace,
        max_iterations: 3,
        check: 'test -f ok.txt',
        check_resolved: 'command',
        effort_ladder: ['low', 'max'],
      });
      let builds = 0;
      const engine = mock_engine((call) => {
        if (call.role === 'critic') return builds < 2 ? reject_reply('the check fails') : approve_reply();
        builds += 1;
        return {
          content: 'built',
          cost_usd: 0.1,
          effect: () => {
            if (builds === 2) writeFileSync(join(workspace, 'ok.txt'), 'ok');
          },
        };
      });
      const result = await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });
      expect(result.status).toBe('success');
      expect(engine.calls.filter((c) => c.role === 'builder').map((c) => c.opts.effort)).toEqual(['low', 'max']);
      const second = JSON.parse(
        readFileSync(join(workspace, '.volley', 'iterations', '002', 'summary.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(second['climbed']).toBe('check_failed');
    } finally {
      cleanup();
    }
  });

  it('records effort_ignored on a seat whose provider drops effort, and only there', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({
        workspace,
        builder_provider: 'ollama',
        builder_model: 'qwen3:8b',
        allow_unsandboxed_builder: true,
        critic_provider: 'lmstudio',
        critic_model: 'qwen3:8b',
        effort_ladder: ['low', 'high'],
        critic_effort: 'high',
      });
      const engine = mock_engine((call) =>
        call.role === 'builder' ? { content: 'built', cost_usd: 0 } : approve_reply(),
      );
      const result = await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });
      expect(result.status).toBe('success');
      // The effort is still sent: fascicle is what drops it.
      expect(engine.calls.map((c) => c.opts.effort)).toEqual(['low', 'high']);
      const first = JSON.parse(
        readFileSync(join(workspace, '.volley', 'iterations', '001', 'summary.json'), 'utf8'),
      ) as { builder: Record<string, unknown>; critic: Record<string, unknown> };
      expect(first.builder['effort_ignored']).toBe(true);
      expect(first.critic['effort_ignored']).toBe(true);
    } finally {
      cleanup();
    }
    const { workspace: claude_workspace, cleanup: claude_cleanup } = temp_workspace();
    try {
      const engine = mock_engine((call) =>
        call.role === 'builder' ? { content: 'built', cost_usd: 0.1 } : approve_reply(),
      );
      await run_volley(
        test_config({ workspace: claude_workspace, effort_ladder: ['low'], critic_effort: 'high' }),
        { renderer: silent_renderer(), engine, install_signal_handlers: false },
      );
      const first = JSON.parse(
        readFileSync(join(claude_workspace, '.volley', 'iterations', '001', 'summary.json'), 'utf8'),
      ) as { builder: Record<string, unknown>; critic: Record<string, unknown> };
      expect(first.builder).not.toHaveProperty('effort_ignored');
      expect(first.critic).not.toHaveProperty('effort_ignored');
    } finally {
      claude_cleanup();
    }
  });
});
