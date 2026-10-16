import { describe, expect, it } from 'vitest';
import { incomplete_generation_error, provider_error, schema_validation_error } from 'fascicle';
import { resolve_config } from '../../src/config.js';
import { verdict_schema } from '../../src/critic/run.js';
import { is_local_builder, is_local_critic, preflight } from '../../src/preflight.js';
import type { PreflightProbes } from '../../src/preflight.js';
import { EXIT_CONFIG_ERROR, EXIT_SUCCESS } from '../../src/exit_codes.js';
import { create_renderer } from '../../src/render/renderer.js';
import type { ResolvedConfig } from '../../src/types.js';
import { temp_git_workspace, temp_workspace } from '../helpers/harness.js';
import { approve_reply, mock_engine, prompt_text } from '../helpers/mock_engine.js';
import type { MockCall, MockReply } from '../helpers/mock_engine.js';

function base(workspace: string) {
  return { prompt: 'do it', workspace, criteria: 'it is done' };
}

/** A renderer that captures its lines so error messages can be asserted. */
function capturing_renderer() {
  const out: string[] = [];
  const renderer = create_renderer({
    mode: 'default',
    show_thinking: true,
    color: false,
    max_cost_usd: null,
    write: (text) => out.push(text),
  });
  return { renderer, output: () => out.join('') };
}

/** Every probe green — including a canary engine whose critic seat answers —
 * so only the config under test decides the code. A fresh mock engine per
 * consultation keeps `calls` logs from bleeding across tests. */
const ALL_GREEN: PreflightProbes = {
  toolchain_missing: () => [],
  worktree_creatable: () => ({ ok: true, detail: 'ws' }),
  endpoint_reachable: async () => true,
  checkride_doctor: () => true,
  canary_engine: () => mock_engine(() => approve_reply()),
};

function claude_config(workspace: string): ResolvedConfig {
  return resolve_config(base(workspace));
}

/** A resolved local-builder config (fully local, so the contained claude_cli auth
 * gate does not apply). The critic seat is `lmstudio`, not `ollama`, so the
 * canary path skips the ollama-only prewarm's real fetch (as the critic_retry
 * tests do). `worktree` is applied post-resolve so a test need not stand up a
 * git repo just to exercise the (injected) worktree probe. */
function local_config(workspace: string, opts: { worktree?: boolean } = {}): ResolvedConfig {
  const config = resolve_config(
    { ...base(workspace), builder_provider: 'ollama', critic_provider: 'lmstudio' },
    { env: { VOLLEY_CONTAINED: '1' } },
  );
  config.worktree = opts.worktree ?? false;
  return config;
}

describe('is_local_builder', () => {
  it('is true only for the local providers', () => {
    expect(is_local_builder('ollama')).toBe(true);
    expect(is_local_builder('lmstudio')).toBe(true);
    expect(is_local_builder('claude_cli')).toBe(false);
  });
});

describe('is_local_critic', () => {
  it('is true only for the local providers', () => {
    expect(is_local_critic('ollama')).toBe(true);
    expect(is_local_critic('lmstudio')).toBe(true);
    expect(is_local_critic('claude_cli')).toBe(false);
  });
});

describe('preflight — all-Claude path never exits 5 from containment', () => {
  it('skips the containment checks even when the probes would fail', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer } = capturing_renderer();
      const code = await preflight(claude_config(workspace), renderer, {}, {
        toolchain_missing: () => ['pnpm'],
        worktree_creatable: () => ({ ok: false, detail: 'no repo' }),
        endpoint_reachable: async () => false,
      });
      expect(code).toBe(EXIT_SUCCESS);
    } finally {
      cleanup();
    }
  });
});

describe('preflight — worktree fate prediction', () => {
  /** The prediction is provider-independent, so these drive the all-Claude
   * config: no containment probes run, only the fate line. */
  function worktree_config(workspace: string, discard = false): ResolvedConfig {
    const config = claude_config(workspace);
    config.worktree = true;
    config.discard_worktree = discard;
    return config;
  }

  it('warns that a --worktree run without --git integrates nothing, and says where the work lands', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer, output } = capturing_renderer();
      const code = await preflight(worktree_config(workspace), renderer, {}, ALL_GREEN);
      expect(code).toBe(EXIT_SUCCESS);
      expect(output()).toContain('will NOT be integrated');
      expect(output()).toContain('volley/<run id>');
      expect(output()).toMatch(/warning:/);
    } finally {
      cleanup();
    }
  });

  it('predicts the squash-merge instead when --git is on', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer, output } = capturing_renderer();
      const config = worktree_config(workspace);
      config.git_checkpoints = true;
      const code = await preflight(config, renderer, {}, ALL_GREEN);
      expect(code).toBe(EXIT_SUCCESS);
      expect(output()).toContain('squash-merges');
      expect(output()).not.toContain('will NOT be integrated');
    } finally {
      cleanup();
    }
  });

  it('predicts a clean discard for the sweep’s throw-away mode', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer, output } = capturing_renderer();
      const code = await preflight(worktree_config(workspace, true), renderer, {}, ALL_GREEN);
      expect(code).toBe(EXIT_SUCCESS);
      expect(output()).toContain('thrown away');
      expect(output()).not.toContain('will NOT be integrated');
    } finally {
      cleanup();
    }
  });

  it('says nothing about a worktree when --worktree is off', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer, output } = capturing_renderer();
      const code = await preflight(claude_config(workspace), renderer, {}, ALL_GREEN);
      expect(code).toBe(EXIT_SUCCESS);
      expect(output()).not.toContain('worktree');
    } finally {
      cleanup();
    }
  });
});

describe('preflight — containment checks for a local builder', () => {
  it('exits 0 when the toolchain, worktree, and endpoint are all present', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer, output } = capturing_renderer();
      const config = local_config(workspace, { worktree: true });
      const code = await preflight(config, renderer, { VOLLEY_MODEL_HOST: 'host.docker.internal' }, ALL_GREEN);
      expect(code).toBe(EXIT_SUCCESS);
      expect(output()).toContain('host.docker.internal');
    } finally {
      cleanup();
    }
  });

  it('exits 5 when the toolchain is missing', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer, output } = capturing_renderer();
      const code = await preflight(local_config(workspace), renderer, {}, {
        ...ALL_GREEN,
        toolchain_missing: () => ['pnpm', 'git'],
      });
      expect(code).toBe(EXIT_CONFIG_ERROR);
      expect(output()).toMatch(/missing toolchain.*pnpm, git/);
    } finally {
      cleanup();
    }
  });

  it('exits 5 when a requested worktree is not creatable', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer } = capturing_renderer();
      const code = await preflight(local_config(workspace, { worktree: true }), renderer, {}, {
        ...ALL_GREEN,
        worktree_creatable: () => ({ ok: false, detail: 'not a git work tree' }),
      });
      expect(code).toBe(EXIT_CONFIG_ERROR);
    } finally {
      cleanup();
    }
  });

  it('does not consult the worktree probe when --worktree is off', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer } = capturing_renderer();
      let consulted = false;
      const code = await preflight(local_config(workspace), renderer, {}, {
        ...ALL_GREEN,
        worktree_creatable: () => {
          consulted = true;
          return { ok: false, detail: 'should not be reached' };
        },
      });
      expect(code).toBe(EXIT_SUCCESS);
      expect(consulted).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("exits 5 when the builder's model endpoint is unreachable", async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer, output } = capturing_renderer();
      const code = await preflight(local_config(workspace), renderer, { VOLLEY_MODEL_HOST: 'host.docker.internal' }, {
        ...ALL_GREEN,
        endpoint_reachable: async () => false,
      });
      expect(code).toBe(EXIT_CONFIG_ERROR);
      expect(output()).toMatch(/builder model endpoint unreachable.*host\.docker\.internal/);
    } finally {
      cleanup();
    }
  });
});

/** Both seats on LM Studio (no ollama-only prewarm fetch from the canary),
 * each with a URL of its own unless the test says otherwise. */
function seat_config(
  workspace: string,
  urls: { builder_url?: string; critic_url?: string },
): ResolvedConfig {
  return resolve_config(
    {
      ...base(workspace),
      builder_provider: 'lmstudio',
      critic_provider: 'lmstudio',
      ...urls,
    },
    { env: { VOLLEY_CONTAINED: '1' } },
  );
}

/** An endpoint probe that records every URL it is asked about. */
function recording_probe(answer: (url: string) => boolean = () => true) {
  const probed: string[] = [];
  const endpoint_reachable = async (url: string): Promise<boolean> => {
    probed.push(url);
    return answer(url);
  };
  return { probed, endpoint_reachable };
}

describe("preflight — each seat's own model endpoint", () => {
  it("probes each seat's own URL, crossed to the host gateway when contained", async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer, output } = capturing_renderer();
      const probe = recording_probe();
      const config = seat_config(workspace, {
        builder_url: 'http://localhost:11522/v1',
        critic_url: 'http://127.0.0.1:11523/v1',
      });
      const code = await preflight(config, renderer, { VOLLEY_MODEL_HOST: 'host.docker.internal' }, {
        ...ALL_GREEN,
        endpoint_reachable: probe.endpoint_reachable,
      });
      expect(code).toBe(EXIT_SUCCESS);
      expect(probe.probed).toEqual([
        'http://host.docker.internal:11522/v1',
        'http://host.docker.internal:11523/v1',
      ]);
      expect(output()).toContain('endpoint: http://host.docker.internal:11522/v1');
      expect(output()).toContain('builder model endpoint: reachable (http://host.docker.internal:11522/v1)');
      expect(output()).toContain('critic model endpoint: reachable (http://host.docker.internal:11523/v1)');
    } finally {
      cleanup();
    }
  });

  it('probes a server both seats share once', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer, output } = capturing_renderer();
      const probe = recording_probe();
      // The env-var fallback and the critic's own spelling of it are one server.
      const config = seat_config(workspace, { critic_url: 'http://box:1234/v1/' });
      const code = await preflight(config, renderer, { VOLLEY_LMSTUDIO_URL: 'http://box:1234/v1' }, {
        ...ALL_GREEN,
        endpoint_reachable: probe.endpoint_reachable,
      });
      expect(code).toBe(EXIT_SUCCESS);
      expect(probe.probed).toEqual(['http://box:1234/v1']);
      expect(output()).toContain('builder and critic model endpoint: reachable');
    } finally {
      cleanup();
    }
  });

  it("exits 5 naming the critic when its endpoint is down, before the canary spends anything", async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer, output } = capturing_renderer();
      const probe = recording_probe((url) => !url.includes('gpu-box'));
      let canary_consulted = false;
      // A claude_cli builder has no endpoint; the local critic's is still probed.
      const config = resolve_config({
        ...base(workspace),
        critic_provider: 'lmstudio',
        critic_url: 'http://gpu-box:1234/v1',
      });
      const code = await preflight(config, renderer, {}, {
        ...ALL_GREEN,
        endpoint_reachable: probe.endpoint_reachable,
        canary_engine: () => {
          canary_consulted = true;
          return mock_engine(() => approve_reply());
        },
      });
      expect(code).toBe(EXIT_CONFIG_ERROR);
      expect(probe.probed).toEqual(['http://gpu-box:1234/v1']);
      expect(output()).toContain('critic model endpoint unreachable: http://gpu-box:1234/v1');
      expect(canary_consulted).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe('preflight — critic-seat canary', () => {
  /** Builder stays claude_cli: the canary keys off the *critic* seat alone, so
   * it must run even when no containment preflight applies. `lmstudio` (not
   * `ollama`) skips the ollama-only prewarm's real fetch. */
  function canary_config(workspace: string): ResolvedConfig {
    return resolve_config({
      ...base(workspace),
      critic_provider: 'lmstudio',
      critic_model: 'local-critic',
    });
  }

  function stream_death(): Error {
    return new provider_error('stream interrupted: fetch failed', { cause_kind: 'network' });
  }

  /** A reply that throws instead of returning. `content` is never read — the
   * mock throws before it would. */
  function err_reply(error: unknown): MockReply {
    return { content: null, error };
  }

  /** A tool-bearing canary call carries `opts.tools` (the local read tools);
   * the tool-less rung drops them — same discriminant as the run-time ladder. */
  function is_tool_call(call: MockCall): boolean {
    return call.opts.tools !== undefined;
  }

  it('exits 0 on a pass: one tiny generate through the real tool wiring + verdict_schema', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer, output } = capturing_renderer();
      const engine = mock_engine(() => approve_reply());
      const code = await preflight(canary_config(workspace), renderer, {}, {
        ...ALL_GREEN,
        canary_engine: () => engine,
      });
      expect(code).toBe(EXIT_SUCCESS);
      expect(engine.calls).toHaveLength(1);
      const call = engine.calls[0] as MockCall;
      // The exact production wiring: workspace read tools + the verdict schema,
      // and a prompt that elicits a real tool call (a call that never
      // enters the tool parser could not fail).
      expect(is_tool_call(call)).toBe(true);
      expect(call.opts.schema).toBe(verdict_schema);
      expect(prompt_text(call)).toContain('read_file');
      expect(output()).toContain('critic canary: ok');
    } finally {
      cleanup();
    }
  });

  it('warns and predicts critic_degraded when tools die but the tool-less rung survives (exit 0)', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer, output } = capturing_renderer();
      const engine = mock_engine((call) =>
        is_tool_call(call) ? err_reply(stream_death()) : approve_reply(),
      );
      const code = await preflight(canary_config(workspace), renderer, {}, {
        ...ALL_GREEN,
        canary_engine: () => engine,
      });
      expect(code).toBe(EXIT_SUCCESS);
      expect(engine.calls).toHaveLength(2);
      expect(is_tool_call(engine.calls[1] as MockCall)).toBe(false);
      expect(output()).toMatch(/model 'local-critic' in the critic seat/);
      expect(output()).toContain('critic_degraded');
    } finally {
      cleanup();
    }
  });

  it('exits 5 naming model×seat when even the tool-less rung dies', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer, output } = capturing_renderer();
      const engine = mock_engine(() => err_reply(stream_death()));
      const code = await preflight(canary_config(workspace), renderer, {}, {
        ...ALL_GREEN,
        canary_engine: () => engine,
      });
      expect(code).toBe(EXIT_CONFIG_ERROR);
      expect(engine.calls).toHaveLength(2);
      expect(output()).toMatch(
        /critic canary failed — model 'local-critic' in the critic seat \(provider: lmstudio\)/,
      );
    } finally {
      cleanup();
    }
  });

  it('exits 5 on a non-provider error without trying the tool-less rung', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer } = capturing_renderer();
      const engine = mock_engine(() =>
        err_reply(new schema_validation_error('verdict did not validate', [], '{}')),
      );
      const code = await preflight(canary_config(workspace), renderer, {}, {
        ...ALL_GREEN,
        canary_engine: () => engine,
      });
      expect(code).toBe(EXIT_CONFIG_ERROR);
      expect(engine.calls).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('predicts the degraded ladder for a critic that runs out of steps (exit 0)', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer, output } = capturing_renderer();
      const engine = mock_engine((call) =>
        is_tool_call(call)
          ? err_reply(new incomplete_generation_error('max_steps', 'still reading'))
          : approve_reply(),
      );
      const code = await preflight(canary_config(workspace), renderer, {}, {
        ...ALL_GREEN,
        canary_engine: () => engine,
      });
      expect(code).toBe(EXIT_SUCCESS);
      expect(engine.calls).toHaveLength(2);
      expect(is_tool_call(engine.calls[1] as MockCall)).toBe(false);
      expect(output()).toContain("'max_steps'");
      expect(output()).toContain('critic_degraded');
    } finally {
      cleanup();
    }
  });

  it('exits 5 when a critic that runs out of steps dies tool-less too', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer } = capturing_renderer();
      const engine = mock_engine((call) =>
        is_tool_call(call)
          ? err_reply(new incomplete_generation_error('tool_calls', ''))
          : err_reply(stream_death()),
      );
      const code = await preflight(canary_config(workspace), renderer, {}, {
        ...ALL_GREEN,
        canary_engine: () => engine,
      });
      expect(code).toBe(EXIT_CONFIG_ERROR);
      expect(engine.calls).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  it('exits 5 on a cut-off verdict without trying the tool-less rung', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer } = capturing_renderer();
      const engine = mock_engine(() =>
        err_reply(new incomplete_generation_error('length', '{"verdict": "appr')),
      );
      const code = await preflight(canary_config(workspace), renderer, {}, {
        ...ALL_GREEN,
        canary_engine: () => engine,
      });
      expect(code).toBe(EXIT_CONFIG_ERROR);
      expect(engine.calls).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('provably skips the canary for a claude_cli critic', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer, output } = capturing_renderer();
      let consulted = false;
      const code = await preflight(claude_config(workspace), renderer, {}, {
        ...ALL_GREEN,
        canary_engine: () => {
          consulted = true;
          return mock_engine(() => approve_reply());
        },
      });
      expect(code).toBe(EXIT_SUCCESS);
      expect(consulted).toBe(false);
      expect(output()).not.toContain('critic canary');
    } finally {
      cleanup();
    }
  });

  it('runs the canary after the containment checks when the builder is local too', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer, output } = capturing_renderer();
      const code = await preflight(local_config(workspace), renderer, {}, ALL_GREEN);
      expect(code).toBe(EXIT_SUCCESS);
      expect(output()).toContain('critic canary: ok');
    } finally {
      cleanup();
    }
  });
});

describe('preflight — gate posture', () => {
  it('says the default posture: watched, reported, not refused', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer, output } = capturing_renderer();
      const code = await preflight(claude_config(workspace), renderer, {}, ALL_GREEN);
      expect(code).toBe(EXIT_SUCCESS);
      expect(output()).toMatch(/gate: watching \d+ path pattern/);
      expect(output()).toContain('not refused');
    } finally {
      cleanup();
    }
  });

  it('predicts the halt when --fail-on-gate-edit is set on a git workspace', async () => {
    const { workspace, cleanup } = temp_git_workspace();
    try {
      const { renderer, output } = capturing_renderer();
      const config = claude_config(workspace);
      config.fail_on_gate_edit = true;
      expect(await preflight(config, renderer, {}, ALL_GREEN)).toBe(EXIT_SUCCESS);
      expect(output()).toContain('halts the run');
    } finally {
      cleanup();
    }
  });

  it('warns that --fail-on-gate-edit cannot fire outside a git repository', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer, output } = capturing_renderer();
      const config = claude_config(workspace);
      config.fail_on_gate_edit = true;
      // Still exit 0: the run is viable, just not the refusal that was asked for.
      expect(await preflight(config, renderer, {}, ALL_GREEN)).toBe(EXIT_SUCCESS);
      expect(output()).toMatch(/warning:/);
      expect(output()).toContain('will not fire');
    } finally {
      cleanup();
    }
  });

  it('says so when nothing is configured as the gate', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer, output } = capturing_renderer();
      const config = claude_config(workspace);
      config.gate_paths = [];
      expect(await preflight(config, renderer, {}, ALL_GREEN)).toBe(EXIT_SUCCESS);
      expect(output()).toContain('no gate paths configured');
    } finally {
      cleanup();
    }
  });
});

describe('preflight — checkride doctor gates both paths', () => {
  it('exits 5 when checkride doctor fails', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { renderer } = capturing_renderer();
      const config = claude_config(workspace);
      config.check_resolved = 'checkride';
      const code = await preflight(config, renderer, {}, { ...ALL_GREEN, checkride_doctor: () => false });
      expect(code).toBe(EXIT_CONFIG_ERROR);
    } finally {
      cleanup();
    }
  });
});
