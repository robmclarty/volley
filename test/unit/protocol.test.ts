import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aborted_error, provider_error, schema_validation_error } from 'fascicle';
import { resolve_config } from '../../src/config.js';
import { EMPTY_USAGE } from '../../src/cost.js';
import {
  check_from_verify,
  CRITIC_FEEDBACK_ARTIFACT,
  fail_reason_of,
  input_to_config,
  result_to_output,
  run_input_schema,
  run_output_schema,
  SUMMARY_MAX_CHARS,
} from '../../src/protocol/index.js';
import type { RunciterRunInput } from '../../src/protocol/index.js';
import type { RunSummary } from '../../src/summary.js';
import { check_error, phase_error } from '../../src/types.js';
import type { RunStatus } from '../../src/types.js';

// runciter.run/1 (runciter's spec §5.4): the RunInput fixture parses, the input
// maps onto a volley config as runciter's volley kind built one (move 1's D24,
// D25, D26), and a run's summary becomes a RunOutput runciter's strict schema
// takes (D12, D28).

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const INPUT_FIXTURE = join(FIXTURES, 'runciter_run_input.json');
const CONTEXT_FIXTURE = join(FIXTURES, 'runciter_run_context.md');

const fixture_json = (): Record<string, unknown> =>
  JSON.parse(readFileSync(INPUT_FIXTURE, 'utf8')) as Record<string, unknown>;

let root = '';
let workspace = '';
let run_dir = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'volley-protocol-'));
  workspace = join(root, 'work');
  run_dir = join(root, 'run');
  mkdirSync(workspace);
  mkdirSync(join(run_dir, 'artifacts'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The fixture, with its workspace, run directory, and context.md where this
 * test put them. */
function local_input(fields: { verify?: string; max_cost_usd?: number | null } = {}): RunciterRunInput {
  const input = run_input_schema.parse(fixture_json());
  return {
    ...input,
    stage: { ...input.stage, verify: fields.verify ?? input.stage.verify },
    workspace: { ...input.workspace, path: workspace },
    run_dir,
    context: { ...input.context, markdown_path: CONTEXT_FIXTURE },
    budget: {
      ...input.budget,
      max_cost_usd: fields.max_cost_usd === undefined ? input.budget.max_cost_usd : fields.max_cost_usd,
    },
  };
}

function with_check_script(): void {
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ scripts: { check: 'checkride' } }));
}

function run_summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: '01JCZ7Q3V8M2K4T6R9X0B5N1HD',
    status: 'success',
    started_at: '2026-11-09T10:00:00.000Z',
    completed_at: '2026-11-09T10:05:00.000Z',
    iterations_completed: 2,
    total_usage: { ...EMPTY_USAGE, input_tokens: 170889, output_tokens: 2727 },
    total_cost_usd: 0.84,
    builder_cost_usd: 0.5,
    critic_cost_usd: 0.34,
    tester_cost_usd: 0,
    check_duration_ms: 1200,
    builder_max_steps_hits: 0,
    final_verdict: 'approved',
    salvaged_branch: null,
    mode: 'run',
    run_state_dir: '/data/runciter/runs/01JCZ7Q3V8M2K4T6R9X0B5N1HD/volley/01JCZ7Q3V8M2K4T6R9X0B5N1HD',
    comparison: {
      builder_transport: 'claude_cli',
      critic_transport: 'claude_cli',
      iterations_to_converge: 2,
      wall_clock_ms: 300_000,
      total_cost_usd: 0.84,
      builder_cost_usd: 0.5,
      critic_cost_usd: 0.34,
      tester_cost_usd: 0,
      tester_passed_early: false,
      final_verdict: 'approved',
      check_trajectory: [
        { iteration: 1, ran: true, ok: false, failing_slots: ['test'] },
        { iteration: 2, ran: true, ok: true, failing_slots: [] },
      ],
      local_salvage: { tool_calls: 0, salvaged_tool_calls: 0, rate: 0 },
      gate_edits: [],
      unmet_criteria: [],
      critic_degraded: false,
      critic_degrade_causes: [],
      rungs: [null, null],
      ladder_flat: true,
    },
    ...overrides,
  };
}

describe('run_input_schema', () => {
  it("parses the spec's example input, every field of §5.4", () => {
    const input = run_input_schema.parse(fixture_json());
    expect(input.protocol).toBe('runciter.run/1');
    expect(input.task.criteria).toContain('pnpm check is green');
    expect(input.stage.verify).toBe('auto');
    expect(input.agent.runner).toBe('process');
    expect(input.workspace.kind).toBe('worktree');
    expect(input.feedback).toBe("The total counted a killed run's cost twice.");
    expect(input.budget).toEqual({ max_cost_usd: 5, timeout_ms: 1_800_000 });
  });

  it('drops a key it does not know, rather than refusing it', () => {
    const json = fixture_json();
    const input = run_input_schema.parse({
      ...json,
      from_a_later_runciter: true,
      task: Object.assign({}, json['task'], { estimate: 3 }),
    });
    expect(input).not.toHaveProperty('from_a_later_runciter');
    expect(input.task).not.toHaveProperty('estimate');
  });

  it('refuses another protocol, and a missing field', () => {
    expect(run_input_schema.safeParse({ ...fixture_json(), protocol: 'runciter.run/2' }).success).toBe(false);
    const { run_dir: _dropped, ...without_run_dir } = fixture_json();
    expect(run_input_schema.safeParse(without_run_dir).success).toBe(false);
  });
});

describe('input_to_config', () => {
  it("maps the prompt, criteria, workspace, budget, check, state and run id as runciter's volley kind did", () => {
    with_check_script();
    const input = local_input();
    const { config, run_id } = input_to_config(input);
    expect(config.prompt).toBe(`${input.agent.prompt}\n\n${readFileSync(CONTEXT_FIXTURE, 'utf8').trim()}`);
    expect(config.criteria).toBe(input.task.criteria);
    expect(config.workspace).toBe(workspace);
    expect(config.max_cost_usd).toBe(5);
    expect(config.check).toBe('pnpm check');
    expect(config.state_dir).toBe(join(run_dir, 'volley'));
    expect(run_id).toBe(input.run_id);
  });

  it("carries the task's feedback through context.md, so a retry sees why the last attempt failed", () => {
    const { config } = input_to_config(local_input());
    expect(config.prompt).toContain("The total counted a killed run's cost twice.");
  });

  it('ignores budget.timeout_ms, which runciter enforces itself', () => {
    const { config } = input_to_config(local_input());
    expect(Object.values(config)).not.toContain(1_800_000);
  });

  it("lets the argv's --check, --state-dir and --run-id win, and passes its other settings through", () => {
    with_check_script();
    const { config, run_id } = input_to_config(local_input(), {
      check: 'pnpm test',
      state_dir: '/elsewhere/state',
      run_id: 'from-argv',
      builder_model: 'sonnet',
      critic_provider: 'ollama',
    });
    expect(config.check).toBe('pnpm test');
    expect(config.state_dir).toBe('/elsewhere/state');
    expect(run_id).toBe('from-argv');
    expect(config.builder_model).toBe('sonnet');
    expect(config.critic_provider).toBe('ollama');
  });

  it("puts runciter's budget over the argv's cap, and keeps the argv's when runciter gives none", () => {
    expect(input_to_config(local_input(), { max_cost_usd: 1 }).config.max_cost_usd).toBe(5);
    expect(input_to_config(local_input({ max_cost_usd: null }), { max_cost_usd: 1 }).config.max_cost_usd).toBe(1);
    expect(input_to_config(local_input({ max_cost_usd: null })).config).not.toHaveProperty('max_cost_usd');
  });

  it('reads stage.verify the way runciter verifies with it', () => {
    expect(input_to_config(local_input({ verify: 'none' })).config.check).toBe('none');
    expect(input_to_config(local_input({ verify: 'make test' })).config.check).toBe('make test');
    // auto with no package.json at all
    expect(input_to_config(local_input({ verify: 'auto' })).config.check).toBe('none');
    expect(check_from_verify('auto', JSON.stringify({ scripts: { test: 'vitest' } }))).toBe('none');
    expect(check_from_verify('auto', 'not json')).toBe('none');
    expect(check_from_verify('auto', JSON.stringify({ scripts: { check: 'checkride' } }))).toBe('pnpm check');
  });

  it("leaves out an empty agent prompt rather than opening on a blank line", () => {
    const input = { ...local_input(), agent: { ...local_input().agent, prompt: '  \n' } };
    expect(input_to_config(input).config.prompt).toBe(readFileSync(CONTEXT_FIXTURE, 'utf8').trim());
  });

  it("refuses an input whose context.md can't be read, naming the path", () => {
    const missing = join(run_dir, 'context.md');
    const input = { ...local_input(), context: { ...local_input().context, markdown_path: missing } };
    expect(() => input_to_config(input)).toThrow(missing);
  });

  it('gives a config volley resolves, its state in the run directory and outside the workspace', () => {
    with_check_script();
    const { config, run_id } = input_to_config(local_input());
    const resolved = resolve_config(config, { run_id, env: {} });
    expect(resolved.run_id).toBe('01JCZ7Q3V8M2K4T6R9X0B5N1HD');
    expect(resolved.state_dir).toBe(join(run_dir, 'volley'));
    expect(resolved.check_resolved).toBe('command');
    expect(resolved.max_cost_usd).toBe(5);
  });
});

describe('result_to_output', () => {
  it('turns a converged run into a passed RunOutput the strict schema takes, and round-trips it', () => {
    const summary = run_summary();
    const output = result_to_output(summary, {
      feedback: 'Approved: the total sums every run once.\n',
      artifacts: [CRITIC_FEEDBACK_ARTIFACT],
    });
    expect(output.status).toBe('passed');
    expect(output).not.toHaveProperty('fail_reason');
    expect(output.summary).toBe(
      'volley: success after 2 iterations, verdict approved.\n\nApproved: the total sums every run once.',
    );
    expect(output.usage).toEqual({
      cost_usd: 0.84,
      cost_source: 'estimated',
      input_tokens: 170889,
      output_tokens: 2727,
    });
    expect(output.artifacts).toEqual([CRITIC_FEEDBACK_ARTIFACT]);
    expect(output.lessons).toEqual([]);
    expect(output.data).toEqual(summary);
    const wire = JSON.parse(JSON.stringify(output)) as unknown;
    expect(run_output_schema.parse(wire)).toEqual(output);
  });

  it('gives a run with no critic feedback a status line for its summary, never an empty one', () => {
    const output = result_to_output(
      run_summary({ status: 'budget_exhausted', iterations_completed: 1, final_verdict: null }),
    );
    expect(output.summary).toBe('volley: budget_exhausted after 1 iteration, verdict none.');
    expect(output).not.toHaveProperty('artifacts');
    expect(output).not.toHaveProperty('detail');
    expect(run_output_schema.parse(JSON.parse(JSON.stringify(output)) as unknown)).toEqual(output);
  });

  it('treats blank feedback as none', () => {
    const output = result_to_output(run_summary(), { feedback: '  \n' });
    expect(output.summary).toBe('volley: success after 2 iterations, verdict approved.');
  });

  it('cuts a long summary to 4000 characters', () => {
    const output = result_to_output(run_summary(), { feedback: 'x'.repeat(10_000) });
    expect(output.summary).toHaveLength(SUMMARY_MAX_CHARS);
    expect(output.summary.endsWith('…')).toBe(true);
    expect(run_output_schema.safeParse(output).success).toBe(true);
  });

  it("names a builder, check or critic error by its phase, with the error's message as the detail", () => {
    const errored = run_summary({ status: 'error', final_verdict: null });
    const builder = result_to_output(errored, { error: phase_error('builder', 1, new provider_error('boom')) });
    expect(builder.status).toBe('failed');
    expect(builder.fail_reason).toBe('builder_error');
    expect(builder.detail).toBe('builder failed on iteration 1: boom');
    expect(result_to_output(errored, { error: check_error('checkride crashed') }).fail_reason).toBe('check_error');
    expect(result_to_output(errored, { error: phase_error('check', 2, new Error('spawn')) }).fail_reason).toBe(
      'check_error',
    );
    expect(
      result_to_output(errored, { error: phase_error('critic', 2, new schema_validation_error('invalid', [], 'raw')) })
        .fail_reason,
    ).toBe('critic_error');
    // runciter has no reason for a tester, whose errors exit as a builder's do
    expect(result_to_output(errored, { error: phase_error('tester', 1, new provider_error('boom')) }).fail_reason).toBe(
      'builder_error',
    );
    expect(result_to_output(errored).fail_reason).toBe('builder_error');
    for (const output of [builder, result_to_output(errored)]) {
      expect(run_output_schema.safeParse(output).success).toBe(true);
    }
  });
});

describe('fail_reason_of', () => {
  it("maps each status onto runciter's runner fail reasons", () => {
    const table: Array<[RunStatus, string | null]> = [
      ['success', null],
      ['budget_exhausted', 'iterations_exhausted'],
      ['cost_cap_reached', 'cost_cap'],
      ['gate_edit_blocked', 'gate_edit_blocked'],
      ['interrupted', 'interrupted'],
      ['tester_passed_early', 'not_passed'],
      ['rejected', 'not_passed'],
      ['running', 'not_passed'],
      ['error', 'builder_error'],
    ];
    for (const [status, reason] of table) expect(fail_reason_of(status)).toBe(reason);
  });

  it('reads an abort under an error as an interruption', () => {
    expect(fail_reason_of('error', phase_error('builder', 1, new aborted_error('sigterm')))).toBe('interrupted');
  });
});

describe('run_output_schema', () => {
  const passed = { protocol: 'runciter.run/1', status: 'passed', summary: 'ok' };

  it('refuses an unknown key, as runciter does', () => {
    expect(run_output_schema.safeParse(passed).success).toBe(true);
    expect(run_output_schema.safeParse({ ...passed, sumary: 'typo' }).success).toBe(false);
    expect(
      run_output_schema.safeParse({ ...passed, usage: { cost_usd: 1, currency: 'usd' } }).success,
    ).toBe(false);
  });

  it('needs a fail reason on a failure, and only one of the eight a runner may report', () => {
    expect(run_output_schema.safeParse({ ...passed, status: 'failed' }).success).toBe(false);
    expect(
      run_output_schema.safeParse({ ...passed, status: 'failed', fail_reason: 'not_passed' }).success,
    ).toBe(true);
    expect(run_output_schema.safeParse({ ...passed, status: 'failed', fail_reason: 'timeout' }).success).toBe(
      false,
    );
  });

  it('refuses an empty summary, and whole-number token counts only', () => {
    expect(run_output_schema.safeParse({ ...passed, summary: '' }).success).toBe(false);
    expect(run_output_schema.safeParse({ ...passed, usage: { input_tokens: 1.5 } }).success).toBe(false);
  });
});
