/**
 * run_volley's injected seat deps and its outside trajectory sink. Left out,
 * they change nothing: the generate options and the file trajectory's event
 * kinds pinned below are what a run produced before the deps existed. Given,
 * each seat's tools (and the builder's approval handler) reach that seat's own
 * calls and no other, and a sink sees the run streamed, model chunks included,
 * while the file keeps every event but those chunks.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { incomplete_generation_error } from 'fascicle';
import type {
  GenerateOptions,
  StreamChunk,
  Tool,
  ToolApprovalHandler,
  TrajectoryEvent,
  TrajectoryLogger,
} from 'fascicle';
import { compose_builder_system, compose_builder_system_local } from '../../src/builder.js';
import { resolve_critic_prompt } from '../../src/critic/prompt.js';
import { run_volley } from '../../src/orchestrator.js';
import type { OrchestratorDeps } from '../../src/orchestrator.js';
import type { Renderer } from '../../src/render/renderer.js';
import type { ResolvedConfig } from '../../src/types.js';
import { silent_renderer, temp_workspace, test_config } from '../helpers/harness.js';
import { approve_reply, mock_engine, prompt_text } from '../helpers/mock_engine.js';
import type { MockCall, MockEngine, MockReply } from '../helpers/mock_engine.js';

const USAGE = { input_tokens: 10, output_tokens: 5 };

const BUILDER_CHUNKS: StreamChunk[] = [
  { kind: 'text', text: 'writing the file', step_index: 0 },
  { kind: 'tool_call_start', id: 'call-1', name: 'write_file', step_index: 0 },
  { kind: 'tool_call_end', id: 'call-1', input: { path: 'out.txt' }, step_index: 0 },
  { kind: 'tool_result', id: 'call-1', output: 'ok', step_index: 0 },
  { kind: 'finish', finish_reason: 'stop', usage: USAGE },
];

const CRITIC_CHUNKS: StreamChunk[] = [
  { kind: 'text', text: '{"verdict":"approved"}', step_index: 0 },
  { kind: 'finish', finish_reason: 'stop', usage: USAGE },
];

/** Both seats stream their chunks; the builder answers, the critic approves. */
function streaming_reply(call: MockCall): MockReply {
  return call.role === 'builder'
    ? { content: 'done', cost_usd: 0.1, chunks: BUILDER_CHUNKS }
    : { ...approve_reply(), chunks: CRITIC_CHUNKS };
}

type Round = {
  config: ResolvedConfig;
  renderer: Renderer;
  engine: MockEngine;
  /** `.volley/trajectory.jsonl`, parsed. */
  file: TrajectoryEvent[];
};

/** Run one round with both seats on `provider` and the given extra deps. */
async function one_round(
  provider: 'claude_cli' | 'lmstudio',
  deps: Partial<Omit<OrchestratorDeps, 'engine'>> = {},
  responder: (call: MockCall, index: number) => MockReply = streaming_reply,
): Promise<Round> {
  const { workspace, cleanup } = temp_workspace();
  try {
    const config = test_config({
      workspace,
      builder_provider: provider,
      builder_model: 'builder-model',
      critic_provider: provider,
      critic_model: 'critic-model',
      max_iterations: 1,
    });
    const renderer = deps.renderer ?? silent_renderer();
    const engine = mock_engine(responder);
    await run_volley(config, { ...deps, renderer, engine, install_signal_handlers: false });
    const file = readFileSync(join(workspace, '.volley', 'trajectory.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TrajectoryEvent);
    return { config, renderer, engine, file };
  } finally {
    cleanup();
  }
}

/** A recorded call's generate options with the values a test can't compare
 * by value (the signal, the trajectory, the schema, the tools) replaced by
 * what identifies them, so `toStrictEqual` pins every key the call carried. */
function options_of(call: MockCall | undefined): Record<string, unknown> {
  const opts: GenerateOptions<unknown> = call?.opts ?? { prompt: '' };
  return Object.fromEntries(
    Object.entries(opts).map(([key, value]) => {
      if (key === 'prompt') return [key, prompt_text(call)];
      if (key === 'abort') return [key, value instanceof AbortSignal ? '<signal>' : value];
      if (key === 'trajectory' || key === 'schema') return [key, `<${key}>`];
      if (key === 'tools') return [key, (value as Tool[]).map((tool) => tool.name)];
      return [key, value];
    }),
  );
}

const BUILDER_PROMPT = [
  'TASK',
  '----',
  'write the file',
  '',
  'ACCEPTANCE CRITERIA',
  '-------------------',
  'the file exists',
  '',
  'ITERATION: 1',
].join('\n');

const CRITIC_PROMPT = [
  'ACCEPTANCE CRITERIA',
  '-------------------',
  'the file exists',
  '',
  'ITERATION: 1',
  '',
  'No deterministic check ran for this iteration. Base your verdict on workspace inspection alone.',
  '',
  'Review the workspace against the acceptance criteria and return your',
  'structured verdict.',
].join('\n');

/** What each seat's call carried before the new deps existed, per provider. */
function todays_options(round: Round): { builder: Record<string, unknown>; critic: Record<string, unknown> } {
  const { config, renderer } = round;
  const shared = { abort: '<signal>', trajectory: '<trajectory>' };
  if (config.builder_provider === 'claude_cli') {
    return {
      builder: {
        ...shared,
        prompt: BUILDER_PROMPT,
        provider: 'claude_cli',
        model: 'builder-model',
        system: compose_builder_system(),
        on_chunk: renderer.builder_chunk,
        provider_options: {
          claude_cli: {
            allowed_tools: ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Grep', 'Glob', 'WebFetch'],
            extra_args: ['--permission-mode', 'acceptEdits'],
          },
        },
      },
      critic: {
        ...shared,
        prompt: CRITIC_PROMPT,
        provider: 'claude_cli',
        model: 'critic-model',
        system: resolve_critic_prompt(config),
        schema: '<schema>',
        on_chunk: renderer.critic_chunk,
        provider_options: {
          claude_cli: {
            allowed_tools: ['Read', 'Grep', 'Glob'],
            extra_args: ['--disallowedTools', 'Write,Edit,MultiEdit,NotebookEdit,Bash'],
          },
        },
      },
    };
  }
  return {
    builder: {
      ...shared,
      prompt: BUILDER_PROMPT,
      provider: 'lmstudio',
      model: 'builder-model',
      system: compose_builder_system_local(),
      on_chunk: renderer.builder_chunk,
      tools: [
        'read_file',
        'search_files',
        'list_files',
        'write_file',
        'edit_file',
        'bash',
        'fetch',
        'finish',
      ],
      max_steps: 50,
      tool_error_policy: 'feed_back',
      tool_call_repair_attempts: 3,
      max_tool_calls_per_step: 1,
    },
    critic: {
      ...shared,
      prompt: CRITIC_PROMPT,
      provider: 'lmstudio',
      model: 'critic-model',
      system: resolve_critic_prompt(config),
      schema: '<schema>',
      on_chunk: renderer.critic_chunk,
      tools: ['read_file', 'search_files', 'list_files'],
      max_steps: 10,
    },
  };
}

function seat_call(engine: MockEngine, role: MockCall['role']): MockCall | undefined {
  return engine.calls.find((call) => call.role === role);
}

/** The event kinds a one-round run's file trajectory held before the sink,
 * plus the phases' progress events (`emit`), which joined it later, on the CLI
 * as under acp. */
const TODAYS_FILE_KINDS = ['emit', 'flow_structure', 'run_end', 'span_end', 'span_start'];

function kinds_of(events: TrajectoryEvent[]): string[] {
  return [...new Set(events.map((event) => event.kind))].sort();
}

/** An event as two sinks can both see it: its kind, plus the span's kind and
 * step id or the chunk's step id. Span ids differ from sink to sink. */
function signature(event: TrajectoryEvent): string {
  const tag = event['name'] ?? event['status'] ?? event['step_id'];
  const id = event['id'];
  return [event.kind, tag, id].filter((part) => typeof part === 'string').join(':');
}

/** A sink that keeps every event, its spans included, in order. */
function recording_sink(): { logger: TrajectoryLogger; events: TrajectoryEvent[] } {
  const events: TrajectoryEvent[] = [];
  let next = 0;
  return {
    events,
    logger: {
      record: (event) => {
        events.push(event);
      },
      start_span: (name, meta) => {
        next += 1;
        const span_id = `sink-${String(next)}`;
        events.push({ ...meta, kind: 'span_start', span_id, name });
        return span_id;
      },
      end_span: (span_id, meta) => {
        events.push({ ...meta, kind: 'span_end', span_id });
      },
    },
  };
}

function tool(name: string): Tool {
  return {
    name,
    description: `the injected ${name}`,
    input_schema: z.object({}),
    execute: () => 'ok',
  };
}

describe('run_volley without the new deps', () => {
  it.each(['claude_cli', 'lmstudio'] as const)(
    'passes the %s seats exactly the generate options it always has',
    async (provider) => {
      const round = await one_round(provider);
      const expected = todays_options(round);
      expect(options_of(seat_call(round.engine, 'builder'))).toStrictEqual(expected.builder);
      expect(options_of(seat_call(round.engine, 'critic'))).toStrictEqual(expected.critic);
      expect(round.engine.calls).toHaveLength(2);
    },
  );

  it("keeps the file trajectory's event kinds, and no streamed chunk, although both seats stream", async () => {
    const round = await one_round('lmstudio');
    expect(kinds_of(round.file)).toStrictEqual(TODAYS_FILE_KINDS);
  });
});

describe('injected seat deps', () => {
  const builder_tools = [tool('run_command'), tool('write_file'), tool('finish')];
  const critic_tools = [tool('read_file'), tool('search')];
  const approve: ToolApprovalHandler = () => true;
  const seats = {
    builder: { tools: builder_tools, on_tool_approval: approve },
    critic: { tools: critic_tools },
  };

  it("hand each seat's tools, and the builder's approval handler, to that seat's call alone", async () => {
    const round = await one_round('lmstudio', { seats });
    const builder = seat_call(round.engine, 'builder');
    const critic = seat_call(round.engine, 'critic');
    const expected = todays_options(round);

    expect(builder?.opts.tools).toHaveLength(builder_tools.length);
    expect(builder?.opts.tools?.every((t, i) => t === builder_tools[i])).toBe(true);
    expect(builder?.opts.on_tool_approval).toBe(approve);
    // Everything else on the builder's call is as it was.
    expect(options_of(builder)).toStrictEqual({
      ...expected.builder,
      tools: ['run_command', 'write_file', 'finish'],
      on_tool_approval: approve,
    });

    expect(critic?.opts.tools).toHaveLength(critic_tools.length);
    expect(critic?.opts.tools?.every((t, i) => t === critic_tools[i])).toBe(true);
    expect(options_of(critic)).toStrictEqual({ ...expected.critic, tools: ['read_file', 'search'] });
  });

  it("keep both out of the critic's tool-less pass", async () => {
    const round = await one_round('lmstudio', { seats }, (call, index) =>
      // The critic's tool-bearing call runs out of steps, which sends it
      // straight to the tool-less rung.
      call.role === 'critic' && index === 1
        ? { content: null, error: new incomplete_generation_error('max_steps', 'still reading') }
        : streaming_reply(call),
    );
    const [builder, critic_tools_call, critic_toolless] = round.engine.calls;
    expect(round.engine.calls).toHaveLength(3);
    expect(builder?.opts.on_tool_approval).toBe(approve);
    expect(critic_tools_call?.opts.tools?.map((t) => t.name)).toStrictEqual(['read_file', 'search']);
    expect(critic_toolless?.role).toBe('critic');
    expect(critic_toolless?.opts).not.toHaveProperty('tools');
    expect(critic_toolless?.opts).not.toHaveProperty('on_tool_approval');
  });

  it('reach no claude_cli seat, which brings its own tools', async () => {
    const round = await one_round('claude_cli', { seats });
    const expected = todays_options(round);
    expect(options_of(seat_call(round.engine, 'builder'))).toStrictEqual(expected.builder);
    expect(options_of(seat_call(round.engine, 'critic'))).toStrictEqual(expected.critic);
  });
});

describe('a trajectory sink', () => {
  it("receives the run streamed: its span starts and the builder's model chunks", async () => {
    const sink = recording_sink();
    const watched: StreamChunk[] = [];
    const renderer: Renderer = {
      ...silent_renderer(),
      builder_chunk: (chunk) => {
        watched.push(chunk);
      },
    };
    await one_round('lmstudio', { trajectory: sink.logger, renderer });

    const started = sink.events.filter((e) => e.kind === 'span_start').map((e) => e['id']);
    expect(started).toEqual(expect.arrayContaining(['build', 'builder', 'check', 'critic_tools']));

    const chunks_of = (step_id: string): unknown[] =>
      sink.events
        .filter((e) => e.kind === 'model_chunk' && e['step_id'] === step_id)
        .map((e) => e['chunk']);
    expect(chunks_of('builder')).toStrictEqual(BUILDER_CHUNKS);
    expect(chunks_of('critic_tools')).toStrictEqual(CRITIC_CHUNKS);

    // The renderer still watches every chunk, beside the stream's forwarder.
    expect(watched).toStrictEqual(BUILDER_CHUNKS);
  });

  it('leaves the file every event but the model chunks', async () => {
    const sink = recording_sink();
    const round = await one_round('lmstudio', { trajectory: sink.logger });

    expect(sink.events.some((e) => e.kind === 'model_chunk')).toBe(true);
    expect(round.file.map(signature)).toStrictEqual(
      sink.events.filter((e) => e.kind !== 'model_chunk').map(signature),
    );
    expect(kinds_of(round.file)).toStrictEqual(TODAYS_FILE_KINDS);
  });
});
