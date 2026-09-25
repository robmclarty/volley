/**
 * The local critic's bounded retry on a provider stream death — the
 * first rung of the degradation ladder. A stochastic Ollama tool-XML
 * parser death is retried once; the retry is counted in the iteration summary.
 * The retry path is provider-agnostic among the local providers, so these
 * use `lmstudio` to avoid the ollama-only prewarm's real fetch.
 */
import { describe, expect, it } from 'vitest';
import { provider_error, schema_validation_error } from 'fascicle';
import type { RunContext } from 'fascicle';
import { MAX_CRITIC_RETRIES, run_critic } from '../../src/critic/run.js';
import { initial_state } from '../../src/loop_state.js';
import { error_kind } from '../../src/types.js';
import type { CauseKind, CheckResult, CriticProvider, LoopState, PhaseError } from '../../src/types.js';
import { approve_reply, mock_engine } from '../helpers/mock_engine.js';
import type { MockCall, MockReply } from '../helpers/mock_engine.js';
import { temp_workspace, test_config } from '../helpers/harness.js';

const failed_check: CheckResult = {
  ran: true,
  runner: 'command',
  ok: false,
  exit_code: 1,
  duration_ms: 12,
  failing_slots: ['test'],
  detail: [],
};

function critic_state(): LoopState {
  return { ...initial_state(), iteration: 1, check: failed_check };
}

/** Only `abort` and `trajectory` are read by `run_critic`; the mock engine
 * ignores the trajectory, so a cast to the full context is enough. */
function ctx(abort: AbortSignal = new AbortController().signal): RunContext {
  return { abort, trajectory: undefined } as unknown as RunContext;
}

function stream_death(cause_kind: CauseKind = 'provider_5xx'): Error {
  return new provider_error('stream interrupted: fetch failed', { cause_kind });
}

/** A reply that throws instead of returning. `content` is required on the
 * shape but never read — the mock throws before it would. */
function err_reply(error: unknown): MockReply {
  return { content: null, error };
}

/** Wire a scripted engine to `run_critic` and hand back the call log for
 * per-attempt assertions. The caller owns cleanup so a throw still tears the
 * temp workspace down. */
function make(
  responder: (call: MockCall, index: number) => MockReply,
  provider: CriticProvider = 'lmstudio',
  signal?: AbortSignal,
): { engine: ReturnType<typeof mock_engine>; invoke: () => Promise<LoopState>; cleanup: () => void } {
  const { workspace, cleanup } = temp_workspace();
  const engine = mock_engine(responder);
  const config = test_config({ workspace, critic_provider: provider, critic_model: 'local-critic' });
  const invoke = (): Promise<LoopState> =>
    run_critic({ engine, config, on_chunk: () => {} }, critic_state(), ctx(signal));
  return { engine, invoke, cleanup };
}

describe('run_critic local retry', () => {
  it('retries a local stream death once, then completes with the retry counted', async () => {
    const { engine, invoke, cleanup } = make((_call, index) =>
      index === 0 ? err_reply(stream_death('provider_5xx')) : approve_reply('LGTM'),
    );
    try {
      const state = await invoke();
      expect(engine.calls).toHaveLength(2);
      expect(state.verdict).toBe('approved');
      expect(state.feedback).toBe('LGTM');
      expect(state.critic?.retries).toBe(1);
      expect(state.critic?.retry_cause_kind).toBe('provider_5xx');
    } finally {
      cleanup();
    }
  });

  it('records retries: 0 and no cause when the first call succeeds', async () => {
    const { engine, invoke, cleanup } = make(() => approve_reply());
    try {
      const state = await invoke();
      expect(engine.calls).toHaveLength(1);
      expect(state.verdict).toBe('approved');
      expect(state.critic?.retries).toBe(0);
      expect(state.critic?.retry_cause_kind).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('fails with a critic phase_error once the whole ladder is exhausted', async () => {
    const { engine, invoke, cleanup } = make(() => err_reply(stream_death('network')));
    try {
      const err = await invoke().then(
        () => null,
        (e: unknown) => e,
      );
      // rung 1's tool-bearing attempts (initial + retry) plus rung 2's tool-less
      // fallback — the fallback dies here too, so the run still ends in a
      // critic phase_error. The degraded-verdict path is covered in critic_fallback.
      expect(engine.calls).toHaveLength(MAX_CRITIC_RETRIES + 2);
      expect(error_kind(err)).toBe('phase_error');
      expect((err as PhaseError).phase).toBe('critic');
      // The cause survives as fascicle's typed provider_error → still exit 6.
      expect(error_kind((err as PhaseError).cause)).toBe('provider_error');
    } finally {
      cleanup();
    }
  });

  it('does not retry a claude_cli critic — the proven path is not the ladder’s', async () => {
    const { engine, invoke, cleanup } = make(() => err_reply(stream_death()), 'claude_cli');
    try {
      await expect(invoke()).rejects.toMatchObject({ kind: 'phase_error', phase: 'critic' });
      expect(engine.calls).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('does not retry once the run is aborted — an abort must stay exit-130', async () => {
    const controller = new AbortController();
    controller.abort();
    const { engine, invoke, cleanup } = make(() => err_reply(stream_death()), 'lmstudio', controller.signal);
    try {
      await expect(invoke()).rejects.toMatchObject({ kind: 'phase_error' });
      expect(engine.calls).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('does not retry a schema validation failure — deterministic, not transient', async () => {
    const { engine, invoke, cleanup } = make(() =>
      err_reply(new schema_validation_error('verdict did not validate', [], '{}')),
    );
    try {
      await expect(invoke()).rejects.toMatchObject({ kind: 'phase_error', phase: 'critic' });
      expect(engine.calls).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});
