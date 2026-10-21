/**
 * The local critic's tool-less fallback — rung 2 of the degradation ladder.
 * When the tool-bearing critique keeps dying on the provider's
 * stream even after the bounded retry, the critic runs one more pass with no tools
 * (only the tool surface enters Ollama's broken parser) but keeps constrained
 * decode, grounded by a workspace file inventory. The verdict is schema-valid and
 * marked `critic_degraded`; a death through the fallback too still fails as a
 * critic `phase_error` (exit 6, unchanged). Tests use `lmstudio` to skip the
 * ollama-only prewarm's real fetch, and drive the tool-bearing vs tool-less rungs
 * off `opts.tools` — the one field that distinguishes them at the engine boundary.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { incomplete_generation_error, provider_error, run, step } from 'fascicle';
import type { FinishReason } from 'fascicle';
import { EMPTY_USAGE } from '../../src/cost.js';
import { CRITIC_MAX_STEPS, MAX_CRITIC_RETRIES, run_critic } from '../../src/critic/run.js';
import { build_critic } from '../../src/flow.js';
import { archive_iteration } from '../../src/iteration.js';
import { initial_state } from '../../src/loop_state.js';
import { build_run_summary } from '../../src/summary.js';
import { error_kind } from '../../src/types.js';
import type {
  CauseKind,
  CheckResult,
  CriticProvider,
  LoopState,
  PhaseError,
  PhaseRecord,
  ResolvedConfig,
  RunResult,
} from '../../src/types.js';
import { iteration_dir } from '../../src/workspace.js';
import { approve_reply, mock_engine, prompt_text } from '../helpers/mock_engine.js';
import type { MockCall, MockReply } from '../helpers/mock_engine.js';
import { temp_workspace, test_config, write_file } from '../helpers/harness.js';

const failed_check: CheckResult = {
  ran: true,
  runner: 'command',
  ok: false,
  exit_code: 1,
  duration_ms: 12,
  failing_slots: ['test'],
  detail: [],
};

const passed_check: CheckResult = {
  ran: true,
  runner: 'command',
  ok: true,
  exit_code: 0,
  duration_ms: 5,
  failing_slots: [],
  detail: [],
  log: '',
};

function critic_state(): LoopState {
  return { ...initial_state(), iteration: 1, check: failed_check };
}

/** Drive `run_critic` the way the flow does: inside a real `run`, so the
 * critic arm's `ctx.call` dispatches through fascicle's runner and the ladder's
 * `retry` / `fallback` see the run's abort signal. */
function invoke_critic(
  engine: ReturnType<typeof mock_engine>,
  config: ResolvedConfig,
  signal?: AbortSignal,
): Promise<LoopState> {
  const critic = build_critic({ engine, config, on_chunk: () => {} });
  return run(
    step('critique', (s: LoopState, ctx) => run_critic({ critic, config }, s, ctx)),
    critic_state(),
    { install_signal_handlers: false, ...(signal !== undefined ? { abort: signal } : {}) },
  );
}

function stream_death(cause_kind: CauseKind = 'provider_5xx'): Error {
  return new provider_error('stream interrupted: fetch failed', { cause_kind });
}

/** A reply that throws instead of returning. `content` is never read — the mock
 * throws before it would. */
function err_reply(error: unknown): MockReply {
  return { content: null, error };
}

/** A tool-bearing critic call carries `opts.tools` (the local read tools); the
 * tool-less fallback drops them. That single field is how the scripted engine
 * tells the two ladder rungs apart. */
function is_tool_call(call: MockCall): boolean {
  return call.opts.tools !== undefined;
}

function make(
  responder: (call: MockCall, index: number) => MockReply,
  provider: CriticProvider = 'lmstudio',
  signal?: AbortSignal,
): {
  engine: ReturnType<typeof mock_engine>;
  workspace: string;
  invoke: () => Promise<LoopState>;
  cleanup: () => void;
} {
  const { workspace, cleanup } = temp_workspace();
  const engine = mock_engine(responder);
  const config = test_config({ workspace, critic_provider: provider, critic_model: 'local-critic' });
  const invoke = (): Promise<LoopState> =>
    invoke_critic(engine, config, signal);
  return { engine, workspace, invoke, cleanup };
}

describe('run_critic tool-less fallback', () => {
  it('falls back tool-less on persistent tool-phase death and marks the verdict degraded', async () => {
    const { engine, workspace, invoke, cleanup } = make((call) =>
      is_tool_call(call) ? err_reply(stream_death('provider_5xx')) : approve_reply('degraded but valid'),
    );
    write_file(workspace, 'answer.ts', 'export const answer = 42;\n');
    try {
      const state = await invoke();
      // Two tool-bearing attempts (initial + the one retry) then one tool-less pass.
      expect(engine.calls).toHaveLength(3);
      expect(is_tool_call(engine.calls[0] as MockCall)).toBe(true);
      expect(is_tool_call(engine.calls[2] as MockCall)).toBe(false);
      // A schema-valid verdict still comes back...
      expect(state.verdict).toBe('approved');
      expect(state.feedback).toBe('degraded but valid');
      // ...marked degraded, with the exhausted retries and cause recorded.
      expect(state.critic?.critic_degraded).toBe(true);
      expect(state.critic?.degrade_cause).toBe('stream_error');
      expect(state.critic?.retries).toBe(MAX_CRITIC_RETRIES);
      expect(state.critic?.retry_cause_kind).toBe('provider_5xx');
      // The fallback prompt is grounded by the paths+sizes inventory.
      const fallback_prompt = prompt_text(engine.calls[2]);
      expect(fallback_prompt).toContain('WORKSPACE FILE INVENTORY');
      expect(fallback_prompt).toContain('answer.ts');
    } finally {
      cleanup();
    }
  });

  it('fails with a critic phase_error when the tool-less pass dies too (exit 6)', async () => {
    const { engine, invoke, cleanup } = make(() => err_reply(stream_death('network')));
    try {
      const err = await invoke().then(
        () => null,
        (e: unknown) => e,
      );
      // Two tool-bearing attempts + the tool-less fallback, all dead.
      expect(engine.calls).toHaveLength(3);
      expect(error_kind(err)).toBe('phase_error');
      expect((err as PhaseError).phase).toBe('critic');
      // The cause survives as fascicle's typed provider_error → still exit 6.
      expect(error_kind((err as PhaseError).cause)).toBe('provider_error');
    } finally {
      cleanup();
    }
  });

  it('never falls back for a claude_cli critic — the proven path is not the ladder’s', async () => {
    const { engine, invoke, cleanup } = make(() => err_reply(stream_death()), 'claude_cli');
    try {
      await expect(invoke()).rejects.toMatchObject({ kind: 'phase_error', phase: 'critic' });
      // One attempt, no retry, no tool-less pass — the claude_cli critic never
      // enters the ladder (its tools ride on provider_options, not `opts.tools`,
      // so `is_tool_call` doesn't apply; a single call is proof enough).
      expect(engine.calls).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});

/** A schema call that ended on `finish` before producing a verdict, the way
 * fascicle throws it. */
function incomplete(finish: FinishReason): Error {
  return new incomplete_generation_error(finish, 'still reading files');
}

describe('run_critic step exhaustion', () => {
  it.each(['max_steps', 'tool_calls'] as const)(
    'goes straight to the tool-less pass on a %s finish, with no retry',
    async (finish) => {
      const { engine, invoke, cleanup } = make((call) =>
        is_tool_call(call) ? err_reply(incomplete(finish)) : approve_reply('judged without tools'),
      );
      try {
        const state = await invoke();
        // One tool-bearing call, then the tool-less pass: another identical tool
        // loop would only run out again.
        expect(engine.calls).toHaveLength(2);
        expect(is_tool_call(engine.calls[0] as MockCall)).toBe(true);
        expect(is_tool_call(engine.calls[1] as MockCall)).toBe(false);
        expect(state.verdict).toBe('approved');
        expect(state.critic?.critic_degraded).toBe(true);
        expect(state.critic?.degrade_cause).toBe('step_exhaustion');
        expect(state.critic?.retries).toBe(0);
        expect(state.critic?.retry_cause_kind).toBeUndefined();
      } finally {
        cleanup();
      }
    },
  );

  it('counts a stream death retried before the steps ran out', async () => {
    const { engine, invoke, cleanup } = make((call, index) => {
      if (index === 0) return err_reply(stream_death('network'));
      return is_tool_call(call) ? err_reply(incomplete('max_steps')) : approve_reply();
    });
    try {
      const state = await invoke();
      expect(engine.calls).toHaveLength(3);
      expect(state.critic?.degrade_cause).toBe('step_exhaustion');
      expect(state.critic?.retries).toBe(1);
      expect(state.critic?.retry_cause_kind).toBe('network');
    } finally {
      cleanup();
    }
  });

  it.each(['length', 'content_filter'] as const)(
    'stays fatal on a %s finish, naming it, with no fallback',
    async (finish) => {
      const { engine, invoke, cleanup } = make(() => err_reply(incomplete(finish)));
      try {
        const err = await invoke().then(
          () => null,
          (e: unknown) => e,
        );
        // A cut-off or blocked response isn't fixed by taking the tools away.
        expect(engine.calls).toHaveLength(1);
        expect(error_kind(err)).toBe('phase_error');
        expect((err as PhaseError).phase).toBe('critic');
        expect(error_kind((err as PhaseError).cause)).toBe('incomplete_generation_error');
        expect(String(err)).toContain(`'${finish}'`);
      } finally {
        cleanup();
      }
    },
  );

  it('never degrades a claude_cli critic that runs out of steps', async () => {
    const { engine, invoke, cleanup } = make(() => err_reply(incomplete('max_steps')), 'claude_cli');
    try {
      await expect(invoke()).rejects.toMatchObject({ kind: 'phase_error', phase: 'critic' });
      expect(engine.calls).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("sets the local critic's step budget explicitly, and leaves the CLI's alone", async () => {
    const local = make(() => approve_reply());
    const cli = make(() => approve_reply(), 'claude_cli');
    try {
      await local.invoke();
      await cli.invoke();
      expect(local.engine.calls[0]?.opts.max_steps).toBe(CRITIC_MAX_STEPS);
      expect(cli.engine.calls[0]?.opts.max_steps).toBeUndefined();
    } finally {
      local.cleanup();
      cli.cleanup();
    }
  });
});

/** A minimal `RunResult` for `build_run_summary` — only its comparison-relevant
 * fields matter here. */
function run_result(): RunResult {
  return {
    run_id: 'test-run-id',
    status: 'success',
    started_at: '2026-07-15T00:00:00.000Z',
    completed_at: '2026-07-15T00:01:30.000Z',
    iterations_completed: 1,
    total_usage: EMPTY_USAGE,
    total_cost_usd: 0.1,
    builder_cost_usd: 0.05,
    critic_cost_usd: 0.05,
    check_duration_ms: 5,
    final_verdict: 'approved',
    salvaged_branch: null,
    run_state_dir: '/state/volley/test-run-id',
    mode: 'run',
  };
}

function critic_record(overrides: Partial<PhaseRecord> = {}): PhaseRecord {
  return {
    provider: 'lmstudio',
    model: 'local-critic',
    session_id: null,
    duration_ms: 5,
    usage: EMPTY_USAGE,
    cost_usd: 0.01,
    cost_source: 'engine_derived',
    finish_reason: 'stop',
    tool_calls: 0,
    salvaged_tool_calls: 0,
    ...overrides,
  };
}

function archived_iteration(workspace: string, critic: PhaseRecord): LoopState {
  const state: LoopState = {
    ...initial_state(),
    iteration: 1,
    verdict: 'approved',
    feedback: 'ok',
    check: passed_check,
    critic,
  };
  return state;
}

/** The persistence half: a degraded verdict must land in *both* the
 * per-iteration archive and the run-level comparison block, and a normal run must
 * report `critic_degraded: false` (additive — old consumers keep parsing). */
describe('critic_degraded persistence', () => {
  it('writes critic_degraded to the iteration archive and the comparison block', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      mkdirSync(join(workspace, '.volley'), { recursive: true });
      const config = test_config({ workspace, critic_provider: 'lmstudio', builder_provider: 'lmstudio' });
      archive_iteration(
        config,
        archived_iteration(
          workspace,
          critic_record({ retries: 1, retry_cause_kind: 'provider_5xx', critic_degraded: true }),
        ),
      );

      // (iteration) — nested under `critic` in .volley/iterations/001/summary.json.
      const archived = JSON.parse(
        readFileSync(join(iteration_dir(config, 1), 'summary.json'), 'utf8'),
      );
      expect(archived.critic.critic_degraded).toBe(true);
      expect(archived.critic.retries).toBe(1);
      expect(archived.critic.retry_cause_kind).toBe('provider_5xx');

      // (comparison block) — build_run_summary reads that archive back.
      expect(build_run_summary(config, run_result()).comparison.critic_degraded).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('records why a verdict degraded, in the archive and the comparison block', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      mkdirSync(join(workspace, '.volley'), { recursive: true });
      const config = test_config({ workspace, critic_provider: 'lmstudio' });
      archive_iteration(
        config,
        archived_iteration(
          workspace,
          critic_record({ retries: 0, critic_degraded: true, degrade_cause: 'step_exhaustion' }),
        ),
      );
      const archived = JSON.parse(
        readFileSync(join(iteration_dir(config, 1), 'summary.json'), 'utf8'),
      );
      expect(archived.critic.degrade_cause).toBe('step_exhaustion');
      expect(build_run_summary(config, run_result()).comparison.critic_degrade_causes).toEqual([
        'step_exhaustion',
      ]);
    } finally {
      cleanup();
    }
  });

  it('reads a degraded archive from before the cause was recorded as a stream error', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      mkdirSync(join(workspace, '.volley'), { recursive: true });
      const config = test_config({ workspace, critic_provider: 'lmstudio' });
      archive_iteration(
        config,
        archived_iteration(workspace, critic_record({ retries: 1, critic_degraded: true })),
      );
      expect(build_run_summary(config, run_result()).comparison.critic_degrade_causes).toEqual([
        'stream_error',
      ]);
    } finally {
      cleanup();
    }
  });

  it('reports critic_degraded false, and omits it from the archive, for a full critique', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      mkdirSync(join(workspace, '.volley'), { recursive: true });
      const config = test_config({ workspace, critic_provider: 'lmstudio' });
      archive_iteration(config, archived_iteration(workspace, critic_record({ retries: 0 })));

      const archived = JSON.parse(
        readFileSync(join(iteration_dir(config, 1), 'summary.json'), 'utf8'),
      );
      expect(archived.critic.critic_degraded).toBeUndefined();
      expect(archived.critic.degrade_cause).toBeUndefined();
      const { comparison } = build_run_summary(config, run_result());
      expect(comparison.critic_degraded).toBe(false);
      expect(comparison.critic_degrade_causes).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
