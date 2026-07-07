/**
 * Scripted `Engine` mock for integration tests (spec §10): generate results
 * and side effects are driven by the test, no provider or subprocess involved.
 */
import type { Engine, GenerateOptions, GenerateResult, UsageTotals } from 'fascicle';

export type MockReply = {
  content: unknown;
  usage?: UsageTotals;
  /** undefined = engine could not price the call (cost omitted). */
  cost_usd?: number;
  session_id?: string;
  duration_ms?: number;
  /** Side effect to run when this call happens (e.g. "builder writes file"). */
  effect?: (opts: GenerateOptions<unknown>) => void | Promise<void>;
  /** Throw instead of returning. */
  error?: unknown;
};

export type MockCall = {
  role: 'builder' | 'critic';
  opts: GenerateOptions<unknown>;
};

export type MockEngine = Engine & {
  calls: MockCall[];
};

const DEFAULT_USAGE: UsageTotals = {
  input_tokens: 1000,
  output_tokens: 200,
  cached_input_tokens: 500,
};

/** Calls with a schema are critic calls; everything else is a builder call. */
export function mock_engine(
  responder: (call: MockCall, index: number) => MockReply,
): MockEngine {
  const calls: MockCall[] = [];
  const generate = async <t>(opts: GenerateOptions<t>): Promise<GenerateResult<t>> => {
    const call: MockCall = {
      role: opts.schema !== undefined ? 'critic' : 'builder',
      opts: opts as GenerateOptions<unknown>,
    };
    const index = calls.length;
    calls.push(call);
    const reply = responder(call, index);
    if (reply.error !== undefined) throw reply.error;
    await reply.effect?.(call.opts);
    const cost =
      reply.cost_usd === undefined
        ? {}
        : {
            cost: {
              total_usd: reply.cost_usd,
              input_usd: reply.cost_usd * 0.6,
              output_usd: reply.cost_usd * 0.4,
              currency: 'USD' as const,
              is_estimate: true as const,
            },
          };
    return {
      content: reply.content as t,
      tool_calls: [],
      steps: [],
      usage: reply.usage ?? DEFAULT_USAGE,
      ...cost,
      finish_reason: 'stop',
      model_resolved: {
        provider: opts.provider ?? 'claude_cli',
        model_id: opts.model ?? 'opus',
      },
      provider_reported: {
        claude_cli: {
          session_id: reply.session_id ?? `mock-session-${String(index)}`,
          duration_ms: reply.duration_ms ?? 1234,
        },
      },
    };
  };
  return {
    generate,
    register_price: () => {},
    resolve_price: () => undefined,
    list_prices: () => ({}),
    dispose: async () => {},
    calls,
  };
}

/** The prompt of a recorded call as text (volley always sends strings). */
export function prompt_text(call: MockCall | undefined): string {
  const prompt = call?.opts.prompt;
  return typeof prompt === 'string' ? prompt : JSON.stringify(prompt) ?? '';
}

export function approve_reply(feedback = 'Looks good.'): MockReply {
  return {
    content: { verdict: 'approved', feedback, unmet_criteria: [] },
    cost_usd: 0.05,
  };
}

export function reject_reply(feedback: string, unmet: string[] = []): MockReply {
  return {
    content: { verdict: 'changes_requested', feedback, unmet_criteria: unmet },
    cost_usd: 0.05,
  };
}
