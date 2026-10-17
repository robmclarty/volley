/**
 * What a volley turn shows in the editor, and what it reads from the thread.
 * `progress_updates` keeps fascicle's mapping and adds volley's own: a
 * `**Round N**` line in the reply, the check's card dressed as a command and
 * closed with its output, the verdict as a thought, and the summary as the
 * turn's last message. A run through the real phases shows the producers and
 * the wrapper agree. `turn_task` renders the history ahead of the prompt.
 */
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { run, step } from 'fascicle';
import type { TrajectoryEvent } from 'fascicle';
import { create_acp_mapper_state } from 'fascicle/acp';
import type { AcpHistoryEntry, AcpTurn } from 'fascicle/acp';
import { describe, expect, it } from 'vitest';
import {
  AGENT_TAIL_CHARS,
  CHECK_OUTPUT_LIMIT_BYTES,
  failure_event,
  follow_rounds,
  progress_updates,
  summary_event,
  turn_task,
} from '../../src/acp_progress.js';
import { run_volley } from '../../src/orchestrator.js';
import type { RunSummary } from '../../src/summary.js';
import { check_error, phase_error } from '../../src/types.js';
import type { CheckResult } from '../../src/types.js';
import { silent_renderer, temp_workspace, test_config } from '../helpers/harness.js';
import { approve_reply, mock_engine, reject_reply } from '../helpers/mock_engine.js';

const TURN = 'turn';

/** A turn's mapper state as `serve_acp` makes it for volley: only the builder
 * streams to the reply. */
function mapper() {
  return create_acp_mapper_state({
    turn_id: TURN,
    stream: (step_id) => (step_id === 'builder' ? 'message' : 'none'),
  });
}

function emit(payload: Record<string, unknown>): TrajectoryEvent {
  return { ...payload, kind: 'emit' };
}

function check_chunk(chunk: Record<string, unknown>): TrajectoryEvent {
  return { kind: 'model_chunk', step_id: 'check', chunk: { step_index: 0, ...chunk } };
}

function message(text: string) {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } };
}

function thought(text: string) {
  return { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } };
}

function console_content(text: string) {
  return [{ type: 'content', content: { type: 'text', text: `\`\`\`console\n${text}\n\`\`\`` } }];
}

function command_result(overrides: Partial<CheckResult>): CheckResult {
  return {
    ran: true,
    runner: 'command',
    ok: true,
    exit_code: 0,
    duration_ms: 5,
    failing_slots: [],
    detail: [],
    log: '',
    ...overrides,
  };
}

/** The updates the check's card sends for `result`, after its run opens. */
function check_card_close(result: CheckResult | { error: string }) {
  const state = mapper();
  progress_updates({ kind: 'span_start', span_id: 's', id: 'check' }, state);
  progress_updates(check_chunk({ kind: 'tool_call_start', id: 'check', name: 'check' }), state);
  const chunk =
    'error' in result
      ? { kind: 'tool_result', id: 'check', error: { message: result.error } }
      : { kind: 'tool_result', id: 'check', output: result };
  return progress_updates(check_chunk(chunk), state);
}

describe('progress_updates over a run through the real phases', () => {
  it('opens each round with a line, shows each check as a command card, and each verdict as a thought', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({
        workspace,
        check: 'test -f done.txt',
        check_resolved: 'command',
        max_iterations: 3,
      });
      let builds = 0;
      const engine = mock_engine((call) => {
        if (call.role === 'critic') {
          return builds === 1
            ? reject_reply('Write done.txt.', ['done.txt exists'])
            : approve_reply('Looks good.');
        }
        builds += 1;
        return {
          content: 'built',
          chunks: [{ kind: 'text', text: `Build ${String(builds)}.`, step_index: 0 }],
          effect: () => {
            if (builds === 2) writeFileSync(join(workspace, 'done.txt'), 'done\n');
          },
        };
      });
      // The run nested in an outer streamed step, the way `acp_turn` runs it.
      const turn = step('acp_turn', (_: null, ctx) =>
        run_volley(config, {
          renderer: silent_renderer(),
          engine,
          trajectory: ctx.trajectory,
          abort: ctx.abort,
          install_signal_handlers: false,
        }),
      );
      const handle = run.stream(turn, null, { install_signal_handlers: false });
      const events: TrajectoryEvent[] = [];
      for await (const event of handle.events) events.push(event);
      const result = await handle.result;
      expect(result.status).toBe('success');

      const state = mapper();
      const updates = events.flatMap((event) => progress_updates(event, state));

      const card = (round: number) => `${TURN}:check:${String(round)}:check`;
      expect(updates).toEqual([
        message('**Round 1**\n\n'),
        message('Build 1.'),
        { sessionUpdate: 'tool_call', toolCallId: card(1), title: 'check', kind: 'execute', status: 'pending' },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: card(1),
          status: 'in_progress',
          rawInput: { command: 'test -f done.txt' },
          title: 'test -f done.txt',
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: card(1),
          status: 'failed',
          rawOutput: { ok: false, exit_code: 1, failing_slots: [] },
          content: console_content('[no output]\n[exit code 1]'),
        },
        thought('\n\n**Round 1 verdict: changes requested**\n\nWrite done.txt.\n\nUnmet criteria:\n- done.txt exists'),
        message('\n\n**Round 2**\n\n'),
        message('Build 2.'),
        { sessionUpdate: 'tool_call', toolCallId: card(2), title: 'check', kind: 'execute', status: 'pending' },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: card(2),
          status: 'in_progress',
          rawInput: { command: 'test -f done.txt' },
          title: 'test -f done.txt',
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: card(2),
          status: 'completed',
          rawOutput: { ok: true, exit_code: 0, failing_slots: [] },
          content: console_content('[no output]\n[exit code 0]'),
        },
        thought('\n\n**Round 2 verdict: approved**\n\nLooks good.'),
      ]);
    } finally {
      cleanup();
    }
  });
});

describe('progress_updates: the check card', () => {
  it("closes with what the command printed, cut at run_command's limit", () => {
    const log = 'x'.repeat(CHECK_OUTPUT_LIMIT_BYTES + 100);
    const [closing] = check_card_close(command_result({ ok: false, exit_code: 2, log }));
    expect(closing).toMatchObject({
      status: 'failed',
      content: console_content(
        `${'x'.repeat(CHECK_OUTPUT_LIMIT_BYTES)}\n` +
          `[output cut at ${String(CHECK_OUTPUT_LIMIT_BYTES)} bytes of ${String(log.length)}]\n[exit code 2]`,
      ),
    });
  });

  it("fences the output past any backticks it printed", () => {
    const [closing] = check_card_close(command_result({ log: '````\nok\n' }));
    expect(closing).toMatchObject({
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '`````console\n````\nok\n[exit code 0]\n`````' } }],
    });
  });

  it("lists checkride's slots, then each failing slot's output", () => {
    const [closing] = check_card_close(
      command_result({
        runner: 'checkride',
        ok: false,
        exit_code: 1,
        failing_slots: ['test'],
        summary: {
          schema_version: 1,
          ok: false,
          total_duration_ms: 9,
          checks: [
            { name: 'types', ok: true },
            { name: 'lint', ok: false, skipped: true },
            { name: 'test', ok: false },
          ],
        },
        detail: [{ slot: 'test', path: '/w/.check/test.txt', content: '1 failed\n', truncated: true }],
      }),
    );
    expect(closing).toMatchObject({
      status: 'failed',
      content: console_content(
        'ok    types\nskip  lint\nFAIL  test\n\n── test ──\n1 failed\n' +
          '[cut; the whole output is in /w/.check/test.txt]\n[exit code 1]',
      ),
    });
  });

  it('closes a check that threw as fascicle closes a failed call, with its error', () => {
    expect(check_card_close({ error: 'check command failed to start (exit 127): nope' })).toEqual([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: `${TURN}:check:1:check`,
        status: 'failed',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'check command failed to start (exit 127): nope' },
          },
        ],
      },
    ]);
  });

  it('adds nothing for check_start and check_end, since the card says both', () => {
    const state = mapper();
    expect(progress_updates(emit({ volley: 'check_start', round: 1, command: 'pnpm test' }), state)).toEqual([]);
    expect(
      progress_updates(
        emit({ volley: 'check_end', round: 1, ok: true, exit_code: 0, failing_slots: [], duration_ms: 3 }),
        state,
      ),
    ).toEqual([]);
  });
});

describe('progress_updates: rounds, verdicts, and the rest', () => {
  it('sets every round after the first apart from the reply before it', () => {
    const state = mapper();
    expect(progress_updates(emit({ volley: 'round_start', round: 1 }), state)).toEqual([
      message('**Round 1**\n\n'),
    ]);
    expect(progress_updates(emit({ volley: 'round_start', round: 3 }), state)).toEqual([
      message('\n\n**Round 3**\n\n'),
    ]);
  });

  it('marks a verdict the critic reached without its tools, and leaves out an empty list', () => {
    const update = progress_updates(
      emit({
        volley: 'verdict',
        round: 2,
        verdict: 'approved',
        feedback: 'Fine.\n',
        unmet_criteria: [],
        degraded: true,
      }),
      mapper(),
    );
    expect(update).toEqual([thought('\n\n**Round 2 verdict: approved** (judged without its tools)\n\nFine.')]);
  });

  it("leaves every other event to fascicle's mapping", () => {
    const state = mapper();
    const text = (step_id: string) => ({
      kind: 'model_chunk',
      step_id,
      chunk: { kind: 'text', text: 'hi', step_index: 0 },
    });
    expect(progress_updates(text('builder'), state)).toEqual([message('hi')]);
    expect(progress_updates(text('critic_tools'), state)).toEqual([]);
    expect(progress_updates(emit({ other: 'thing' }), state)).toEqual([]);
  });
});

/** A run's summary, converged in one round unless `overrides` say otherwise. */
function run_summary(
  overrides: Partial<RunSummary> = {},
  comparison: Partial<RunSummary['comparison']> = {},
): RunSummary {
  return {
    run_id: 'r',
    status: 'success',
    started_at: '2026-10-17T00:00:00.000Z',
    completed_at: '2026-10-17T00:01:00.000Z',
    iterations_completed: 1,
    total_usage: { input_tokens: 0, output_tokens: 0 },
    total_cost_usd: 0,
    builder_cost_usd: 0,
    critic_cost_usd: 0,
    check_duration_ms: 0,
    final_verdict: 'approved',
    salvaged_branch: null,
    ...overrides,
    comparison: {
      builder_transport: 'native',
      critic_transport: 'native',
      iterations_to_converge: 1,
      wall_clock_ms: 60_000,
      total_cost_usd: 0,
      builder_cost_usd: 0,
      critic_cost_usd: 0,
      final_verdict: 'approved',
      check_trajectory: [],
      local_salvage: { tool_calls: 0, salvaged_tool_calls: 0, rate: 0 },
      gate_edits: [],
      unmet_criteria: [],
      critic_degraded: false,
      critic_degrade_causes: [],
      ...comparison,
    },
  };
}

function summary_message(event: Record<string, unknown>): unknown {
  return progress_updates(emit(event), mapper());
}

describe('the summary that ends the turn', () => {
  it('says a converged run converged, in how many rounds, with its last verdict', () => {
    expect(summary_message(summary_event(run_summary()))).toEqual([
      message('\n\n**Converged** in 1 round. Last verdict: approved.'),
    ]);
  });

  it("lists what a run that didn't converge still missed, its gate edits, and a degraded verdict", () => {
    const summary = run_summary(
      { status: 'budget_exhausted', iterations_completed: 3, final_verdict: 'changes_requested' },
      {
        unmet_criteria: ['handles empty input', 'documents the flag'],
        gate_edits: ['package.json', 'test/a.test.ts'],
        critic_degraded: true,
      },
    );
    expect(summary_message(summary_event(summary))).toEqual([
      message(
        '\n\n**Not converged** after 3 rounds, the most this run allows. Last verdict: changes requested.' +
          '\n\nStill unmet:\n- handles empty input\n- documents the flag' +
          '\n\nThe builder edited files that decide whether its work passes: package.json, test/a.test.ts.' +
          '\n\nAt least one verdict came from a critic that judged without its tools, so it saw less than usual.',
      ),
    ]);
  });

  it('names the cost cap and a blocked gate edit as the reasons a run stopped', () => {
    const capped = run_summary({ status: 'cost_cap_reached', iterations_completed: 2, final_verdict: null });
    expect(summary_message(summary_event(capped))).toEqual([
      message('\n\n**Not converged**: the run reached its cost cap after 2 rounds. Last verdict: none.'),
    ]);
    const blocked = run_summary(
      { status: 'gate_edit_blocked', final_verdict: 'approved' },
      { gate_edits: ['vitest.config.ts'] },
    );
    expect(summary_message(summary_event(blocked))).toEqual([
      message(
        '\n\n**Stopped** after 1 round: the builder edited the gate, and --fail-on-gate-edit ends the run.' +
          ' Last verdict: approved.' +
          '\n\nThe builder edited files that decide whether its work passes: vitest.config.ts.',
      ),
    ]);
  });

  it('says where a run that threw failed: the round, the phase, and the error underneath', () => {
    const phase = phase_error('critic', 2, new Error('schema mismatch'));
    expect(summary_message(failure_event(phase, 2))).toEqual([
      message('\n\n**Run failed** in round 2, during the critique: schema mismatch'),
    ]);
    const check = check_error('check command failed to start (exit 127): pnpm test');
    expect(summary_message(failure_event(check, 1))).toEqual([
      message('\n\n**Run failed** in round 1, during the check: check command failed to start (exit 127): pnpm test'),
    ]);
    expect(summary_message(failure_event(new Error('no workspace'), 0))).toEqual([
      message('\n\n**Run failed** before the first round: no workspace'),
    ]);
  });
});

describe('follow_rounds', () => {
  it('passes every event on and keeps the last round a run started', () => {
    const seen: TrajectoryEvent[] = [];
    const rounds = follow_rounds({ record: (event) => seen.push(event), start_span: () => 's', end_span: () => {} });
    expect(rounds.round()).toBe(0);
    rounds.sink.record(emit({ volley: 'round_start', round: 1 }));
    rounds.sink.record(emit({ volley: 'verdict', round: 1 }));
    rounds.sink.record(emit({ volley: 'round_start', round: 2 }));
    expect(rounds.round()).toBe(2);
    expect(seen).toHaveLength(3);
  });
});

function acp_turn(text: string, history: AcpHistoryEntry[]): AcpTurn {
  return { session_id: 's', cwd: '/w', text, prompt: [], history };
}

describe('turn_task', () => {
  it('is the prompt alone on a first turn, its attached files whole', () => {
    const text = 'fix @a.ts\n\n<context ref="file:///w/a.ts">\nconst a = 1;\n</context>';
    expect(turn_task(acp_turn(text, []))).toBe(text);
  });

  it('renders the history ahead of the prompt: files named, a reply cut to its end, a stop marked', () => {
    const reply = `${'early work. '.repeat(300)}**Not converged** after 3 rounds.`;
    const tail = reply.slice(-AGENT_TAIL_CHARS);
    const now = 'and the docs\n\n<context ref="file:///w/README.md">\n# Readme\n</context>';
    const task = turn_task(
      acp_turn(now, [
        {
          role: 'user',
          text:
            'make it faster file:///w/a.ts file:///w/b.ts' +
            '\n\n<context ref="file:///w/a.ts">\nSECRET A\n</context>' +
            '\n\n<context ref="file:///w/b.ts">\nline one\n</context>\nSECRET B\n</context>',
        },
        { role: 'agent', text: reply },
        { role: 'user', text: 'also rename it' },
        { role: 'agent', text: '**Round 1**\n\nRenaming', cancelled: true },
      ]),
    );

    expect(task).toBe(
      [
        'The conversation so far, oldest first:',
        'User: make it faster file:///w/a.ts file:///w/b.ts\n[attached: file:///w/a.ts]\n[attached: file:///w/b.ts]',
        `Volley: …${tail}`,
        'User: also rename it',
        'Volley: **Round 1**\n\nRenaming\n\n' +
          '[The user stopped this turn here. Leave what it asked for unless they ask again.]',
        'The request now:',
        now,
      ].join('\n\n'),
    );
  });
});
