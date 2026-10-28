/**
 * The `openrouter` seat provider, end to end. The real engines and fascicle's
 * native OpenAI-compatible transport run against stand-in OpenRouter servers,
 * one per seat, so every request a seat makes can be traced to the server it
 * reached, with the key and the attribution it carried.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve_config } from '../../src/config.js';
import { EXIT_SUCCESS } from '../../src/exit_codes.js';
import { run_volley } from '../../src/orchestrator.js';
import { preflight } from '../../src/preflight.js';
import type { RunSummary } from '../../src/summary.js';
import type { VolleyConfig } from '../../src/types.js';
import { silent_renderer, temp_workspace } from '../helpers/harness.js';
import { close_servers } from '../helpers/http_server.js';
import { stub_openai } from '../helpers/openai_stub.js';
import type { StubOpenAi } from '../helpers/openai_stub.js';

const KEY = 'sk-or-test';

/** The test file's own state root (`test/setup.ts`), which an explicit env
 * would otherwise hide, sending each run's state to the real home. */
const ENV = { OPENROUTER_API_KEY: KEY, XDG_STATE_HOME: process.env['XDG_STATE_HOME'] };

const APPROVED = JSON.stringify({
  verdict: 'approved',
  feedback: 'Looks good.',
  unmet_criteria: [],
});

function requests(stub: StubOpenAi): string[] {
  return stub.seen.map(({ method, path }) => `${method} ${path}`);
}

/** Both seats on OpenRouter, uncontained by explicit opt-out, one iteration
 * with no check, so a single approving verdict ends the run. */
function openrouter_seats(workspace: string, urls: Partial<VolleyConfig> = {}): VolleyConfig {
  return {
    prompt: 'write the file',
    workspace,
    criteria: 'the file exists',
    check: 'none',
    max_iterations: 1,
    builder_provider: 'openrouter',
    builder_model: 'vendor/builder-model',
    critic_provider: 'openrouter',
    critic_model: 'vendor/critic-model',
    allow_unsandboxed_builder: true,
    ...urls,
  };
}

beforeEach(() => {
  // The run reads the engine's environment from the process. Pin everything
  // that could re-point, reprice, or re-key it, so the developer's shell can't.
  vi.stubEnv('VOLLEY_MODEL_HOST', '');
  vi.stubEnv('VOLLEY_PRICING_PATH', '');
  vi.stubEnv('VOLLEY_AUTH_MODE', 'auto');
  vi.stubEnv('VOLLEY_OPENROUTER_URL', '');
  vi.stubEnv('OPENROUTER_API_KEY', KEY);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await close_servers();
});

/** The text of the `[volley]` countdown notes among a request's messages. */
function countdown_notes(messages: unknown[]): string[] {
  return messages
    .map((message) => (message as { role?: unknown; content?: unknown }))
    .filter((message) => message.role === 'user' && typeof message.content === 'string')
    .map((message) => message.content as string)
    .filter((content) => content.startsWith('[volley]'));
}

describe("the builder's step countdown, through fascicle's real tool loop", () => {
  it('ends only the last turns with a note, never keeps one, and counts the cutoff', async () => {
    // A builder that lists files every turn and never finishes, against a
    // four-step budget: the countdown covers the last two.
    const builder_server = await stub_openai([
      { tool_call: { id: 'call_1', name: 'list_files', input: {} } },
    ]);
    const critic_server = await stub_openai(APPROVED);
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config(
        openrouter_seats(workspace, {
          builder_url: builder_server.url,
          critic_url: critic_server.url,
          builder_max_steps: 4,
        }),
        { env: ENV },
      );
      const result = await run_volley(config, {
        renderer: silent_renderer(),
        install_signal_handlers: false,
      });

      const notes = builder_server.seen.map((request) => countdown_notes(request.messages));
      expect(notes).toHaveLength(4);
      expect(notes[0]).toEqual([]);
      expect(notes[1]).toEqual([]);
      expect(notes[2]).toEqual([expect.stringContaining('[volley] 2 steps left in this session')]);
      // The transcript kept none of the earlier note: each turn sends only its own.
      expect(notes[3]).toEqual([expect.stringContaining('This is the last step of this session')]);
      for (const request of builder_server.seen.slice(2)) {
        expect(request.messages.at(-1)).toMatchObject({ role: 'user' });
      }

      expect(result.builder_max_steps_hits).toBe(1);
    } finally {
      cleanup();
    }
  });
});

describe("the builder's per-turn cap, through fascicle's real tool loop", () => {
  it("runs a turn's reads beside its one change, and names the call it dropped", async () => {
    // At the default cap of one, a turn that reads twice, writes, and runs a
    // command: the reads don't count, the write is the turn's one counted
    // call, and the command is dropped. The next turn finishes.
    const builder_server = await stub_openai([
      {
        tool_calls: [
          { id: 'call_1', name: 'list_files', input: {} },
          { id: 'call_2', name: 'search_files', input: { pattern: 'x' } },
          { id: 'call_3', name: 'write_file', input: { path: 'out.txt', content: 'done' } },
          { id: 'call_4', name: 'bash', input: { command: 'touch ran.txt' } },
        ],
      },
      { tool_call: { id: 'call_5', name: 'finish', input: { summary: 'wrote out.txt' } } },
    ]);
    const critic_server = await stub_openai(APPROVED);
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config(
        openrouter_seats(workspace, {
          builder_url: builder_server.url,
          critic_url: critic_server.url,
        }),
        { env: ENV },
      );
      const result = await run_volley(config, {
        renderer: silent_renderer(),
        install_signal_handlers: false,
      });
      expect(result.status).toBe('success');
      expect(readFileSync(join(workspace, 'out.txt'), 'utf8')).toBe('done');
      expect(existsSync(join(workspace, 'ran.txt'))).toBe(false);

      const second = builder_server.seen[1]?.messages ?? [];
      const results = second.filter((message) => (message as { role?: unknown }).role === 'tool');
      expect(results).toHaveLength(3);
      const notice = second
        .map((message) => (message as { role?: unknown; content?: unknown }))
        .find((message) => message.role === 'user' && typeof message.content === 'string' && message.content.includes('bash('));
      expect(notice?.content).toContain('touch ran.txt');
    } finally {
      cleanup();
    }
  });
});

describe('both seats on openrouter, against stand-in OpenRouter servers', () => {
  it('runs each seat on its own server, with the key, the title, and its own model', async () => {
    const builder_server = await stub_openai('done');
    const critic_server = await stub_openai(APPROVED);
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config(
        openrouter_seats(workspace, {
          builder_url: builder_server.url,
          critic_url: critic_server.url,
        }),
        { env: ENV },
      );
      const result = await run_volley(config, {
        renderer: silent_renderer(),
        install_signal_handlers: false,
      });

      expect(result.status).toBe('success');
      for (const [server, model] of [
        [builder_server, 'vendor/builder-model'],
        [critic_server, 'vendor/critic-model'],
      ] as const) {
        expect(requests(server)).toEqual(['POST /v1/chat/completions']);
        expect(server.seen).toEqual([
          expect.objectContaining({
            model,
            stream: true,
            authorization: `Bearer ${KEY}`,
            x_title: 'volley',
          }),
        ]);
      }

      const summary = JSON.parse(
        readFileSync(join(result.run_state_dir, 'summary.json'), 'utf8'),
      ) as RunSummary;
      expect(summary.comparison.builder_transport).toBe('native');
      expect(summary.comparison.critic_transport).toBe('native');
    } finally {
      cleanup();
    }
  });

  it('reads a critic verdict with null feedback and unmet criteria as an empty one', async () => {
    // A critic that holds tools isn't constrain-decoded, so the model can
    // answer null where the schema asks for text and a list. fascicle's own
    // parse used to refuse it, and the run exited 6.
    const builder_server = await stub_openai('done');
    const critic_server = await stub_openai(
      JSON.stringify({ verdict: 'approved', feedback: null, unmet_criteria: null }),
    );
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config(
        openrouter_seats(workspace, {
          builder_url: builder_server.url,
          critic_url: critic_server.url,
        }),
        { env: ENV },
      );
      const result = await run_volley(config, {
        renderer: silent_renderer(),
        install_signal_handlers: false,
      });

      expect(result.status).toBe('success');
      expect(result.final_verdict).toBe('approved');
      const summary = JSON.parse(
        readFileSync(join(result.run_state_dir, 'summary.json'), 'utf8'),
      ) as RunSummary;
      expect(summary.comparison.unmet_criteria).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('sends both seats to VOLLEY_OPENROUTER_URL when neither names a URL', async () => {
    const shared_server = await stub_openai(APPROVED);
    const unused_server = await stub_openai(APPROVED);
    vi.stubEnv('VOLLEY_OPENROUTER_URL', `${shared_server.url}/`);
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config(openrouter_seats(workspace), {
        env: ENV,
      });
      const result = await run_volley(config, {
        renderer: silent_renderer(),
        install_signal_handlers: false,
      });

      expect(result.status).toBe('success');
      expect(new Set(shared_server.seen.map(({ model }) => model))).toEqual(
        new Set(['vendor/builder-model', 'vendor/critic-model']),
      );
      expect(unused_server.seen).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("probes each seat's own server in --dry-run, and posts nothing", async () => {
    const builder_server = await stub_openai('done');
    const critic_server = await stub_openai(APPROVED);
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = resolve_config(
        openrouter_seats(workspace, {
          builder_url: builder_server.url,
          critic_url: critic_server.url,
        }),
        { env: ENV },
      );
      const code = await preflight(config, silent_renderer(), {}, {
        toolchain_missing: () => [],
      });

      expect(code).toBe(EXIT_SUCCESS);
      expect(requests(builder_server)).toEqual(['GET /v1']);
      expect(requests(critic_server)).toEqual(['GET /v1']);
    } finally {
      cleanup();
    }
  });
});
