import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from 'fascicle';
import { acp_seat_tools } from '../../src/acp_tools.js';
import {
  compose_critic_prompt,
  presets_dir,
  resolve_critic_prompt,
} from '../../src/critic/prompt.js';
import { make_critic_toolless_step, make_critic_tools_step } from '../../src/critic/run.js';
import type { CriticDeps } from '../../src/critic/run.js';
import { skipped_check } from '../../src/check/command.js';
import { acp_session, temp_workspace, test_config } from '../helpers/harness.js';
import { approve_reply, mock_engine } from '../helpers/mock_engine.js';
import type { ChangeSet, CheckResult, CriticProvider, ResolvedConfig } from '../../src/types.js';

describe('presets', () => {
  it('ships one markdown file per preset, discoverable by listing', () => {
    const files = readdirSync(presets_dir());
    expect(files).toContain('reviewer.md');
    expect(files).toContain('optimizer.md');
    expect(files).toContain('researcher.md');
    expect(files).toContain('harness_append.md');
    expect(files).toContain('harness_append_local.md');
    expect(files).toContain('harness_append_acp.md');
  });

  it('appends the harness instructions to every preset', () => {
    for (const preset of ['reviewer', 'optimizer', 'researcher'] as const) {
      const prompt = resolve_critic_prompt(
        test_config({ workspace: '/tmp', critic_preset: preset }),
      );
      expect(prompt).toContain('volley harness');
      expect(prompt).toContain('read-only access');
      expect(prompt).toContain('structured verdict');
    }
  });

  it('names the local read-only tools for a non-CLI critic provider', () => {
    const cli_prompt = resolve_critic_prompt(
      test_config({ workspace: '/tmp', critic_preset: 'reviewer', critic_provider: 'claude_cli' }),
    );
    expect(cli_prompt).toContain('(Read, Grep, Glob)');

    const local_prompt = resolve_critic_prompt(
      test_config({ workspace: '/tmp', critic_preset: 'reviewer', critic_provider: 'ollama' }),
    );
    expect(local_prompt).toContain('read_file(path)');
    expect(local_prompt).toContain('search_files');
    expect(local_prompt).toContain('list_files');
    expect(local_prompt).not.toContain('(Read, Grep, Glob)');
  });

  it('points each critic at prior iteration state where the build root holds it', () => {
    for (const [critic_provider, line] of [
      ['claude_cli', 'Prior iteration state is visible in .volley/iterations/.'],
      ['ollama', 'Prior iteration state is visible under the .volley/iterations/ directory.'],
    ] as const) {
      expect(resolve_critic_prompt(test_config({ workspace: '/w', critic_provider }))).toContain(
        line,
      );
    }
    // A root inside the workspace is named by where it actually is.
    const nested = resolve_critic_prompt(
      test_config({ workspace: '/w', state_dir: '/w/runs', run_id: 'r1' }),
    );
    expect(nested).toContain('Prior iteration state is visible in runs/r1/iterations/.');
    expect(nested).not.toContain('{{');
  });

  it("drops the prior-state line when the run's state sits outside the build root", () => {
    for (const critic_provider of ['claude_cli', 'ollama'] as const) {
      for (const outside of [
        test_config({ workspace: '/w', critic_provider, state_dir: '/state' }),
        // Under --worktree the critic reads the sibling checkout, not `.volley/`.
        test_config({ workspace: '/w', critic_provider, worktree: true }),
      ]) {
        const prompt = resolve_critic_prompt(outside);
        expect(prompt).not.toContain('Prior iteration state');
        expect(prompt).not.toContain('{{');
        expect(prompt).toContain('You are running inside the volley harness.');
        expect(prompt).toContain('read-only access');
      }
    }
  });

  it('uses a custom prompt file when configured', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const path = join(workspace, 'custom.md');
      writeFileSync(path, 'You are a bespoke critic.');
      const prompt = resolve_critic_prompt(
        test_config({ workspace, critic_preset: 'custom', critic_prompt_path: path }),
      );
      expect(prompt).toContain('bespoke critic');
      expect(prompt).toContain('volley harness');
    } finally {
      cleanup();
    }
  });
});

describe('resolve_critic_prompt: the acp set', () => {
  const acp = (overrides: Partial<ResolvedConfig> = {}): string =>
    resolve_critic_prompt(test_config({ workspace: '/w', critic_provider: 'openrouter', ...overrides }), 'acp');

  it("names fascicle's three reads and none of volley's", () => {
    const flat = acp().replace(/\s+/g, ' ');
    for (const call of [
      'read_file(path, offset?, limit?)',
      'list_files(pattern?, path?)',
      'search(pattern, path?, glob?)',
    ]) {
      expect(flat).toContain(call);
    }
    for (const absent of ['search_files', '(Read, Grep, Glob)', 'run_command(', 'write_file(']) {
      expect(flat).not.toContain(absent);
    }
    expect(flat).toContain('read-only access');
    expect(flat).toContain('structured verdict');
  });

  it('places or drops the prior-state line as the local append does', () => {
    expect(acp()).toContain('Prior iteration state is visible under the .volley/iterations/ directory.');
    // acp's default state root is outside the workspace, where no read reaches.
    const outside = acp({ state_dir: '/state' });
    expect(outside).not.toContain('Prior iteration state');
    expect(outside).not.toContain('{{');
  });
});

describe("the critic seat's system prompt", () => {
  /** The system prompt each rung of a critic seat's ladder carries, given the
   * seat's injected deps. */
  async function seat_systems(
    critic_provider: CriticProvider,
    seat: Pick<CriticDeps, 'tools' | 'tool_set'> = {},
  ): Promise<Array<string | undefined>> {
    const { workspace, cleanup } = temp_workspace();
    try {
      const engine = mock_engine(() => approve_reply());
      const config = test_config({ workspace, critic_provider, critic_model: 'critic-model' });
      const deps: CriticDeps = { engine, config, on_chunk: () => undefined, ...seat };
      for (const step of [make_critic_tools_step(deps), make_critic_toolless_step(deps)]) {
        await run(step, 'review it', { install_signal_handlers: false });
      }
      return engine.calls.map((call) => call.opts.system);
    } finally {
      cleanup();
    }
  }

  it("is today's prompt, byte for byte, for a seat with no injected set", async () => {
    const append = readFileSync(join(presets_dir(), 'harness_append_local.md'), 'utf8')
      .replaceAll('{{iterations_dir}}', '.volley/iterations/')
      .trimEnd();
    const reviewer = readFileSync(join(presets_dir(), 'reviewer.md'), 'utf8').trimEnd();
    const today = `${reviewer}\n\n${append}`;
    for (const provider of ['ollama', 'lmstudio', 'openrouter'] as const) {
      expect(await seat_systems(provider)).toEqual([today, today]);
      expect(await seat_systems(provider, { tool_set: 'volley' })).toEqual([today, today]);
    }
  });

  it('is the acp append on both rungs for a seat holding the acp set', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { critic } = acp_seat_tools(acp_session(workspace));
      const systems = await seat_systems('openrouter', critic);
      expect(systems).toHaveLength(2);
      for (const system of systems) {
        expect(system).toContain('search(pattern, path?, glob?)');
        expect(system).not.toContain('search_files');
      }
      expect(systems[0]).toBe(systems[1]);
    } finally {
      cleanup();
    }
  });

  it('stays the CLI append for a claude_cli critic, which takes no injected set', async () => {
    const systems = await seat_systems('claude_cli', { tools: [], tool_set: 'acp' });
    for (const system of systems) {
      expect(system).toContain('(Read, Grep, Glob)');
      expect(system).not.toContain('search(pattern');
    }
  });
});

describe('compose_critic_prompt', () => {
  it('includes criteria, iteration, and failing check artifacts', () => {
    const check: CheckResult = {
      ran: true,
      runner: 'checkride',
      ok: false,
      exit_code: 1,
      duration_ms: 100,
      failing_slots: ['test'],
      detail: [
        { slot: 'test', path: '/w/.check/test.json', content: '{"failed": 1}', truncated: false },
      ],
      summary: { schema_version: 1, ok: false },
    };
    const prompt = compose_critic_prompt({ criteria: '- it works', iteration: 2, check, changes: null });
    expect(prompt).toContain('- it works');
    expect(prompt).toContain('ITERATION: 2');
    expect(prompt).toContain('FAILED');
    expect(prompt).toContain('failing slots: test');
    expect(prompt).toContain('{"failed": 1}');
  });

  it('says so when no check ran', () => {
    const prompt = compose_critic_prompt({
      criteria: 'c',
      iteration: 1,
      check: skipped_check('none'),
      changes: null,
    });
    expect(prompt).toContain('No deterministic check ran');
  });

  it('includes the command runner log', () => {
    const check: CheckResult = {
      ran: true,
      runner: 'command',
      ok: false,
      exit_code: 1,
      duration_ms: 5,
      failing_slots: [],
      detail: [],
      log: '1 test failed: widget spins backwards',
    };
    const prompt = compose_critic_prompt({ criteria: 'c', iteration: 1, check, changes: null });
    expect(prompt).toContain('widget spins backwards');
  });
});

describe('compose_critic_prompt — builder changes', () => {
  const check = skipped_check('none');
  const compose = (changes: ChangeSet | null): string =>
    compose_critic_prompt({ criteria: 'c', iteration: 1, check, changes });

  function change_set(overrides: Partial<ChangeSet> = {}): ChangeSet {
    return {
      baseline: 'abcdef1234567890abcdef1234567890abcdef12',
      files: [{ path: 'src/a.mjs', status: 'modified', gate: false }],
      gate_edits: [],
      total: 1,
      truncated: false,
      ...overrides,
    };
  }

  it('omits the section entirely when change detection is unavailable', () => {
    expect(compose(null)).not.toContain('BUILDER CHANGES');
  });

  it('lists the changed paths with their status and the baseline', () => {
    const prompt = compose(
      change_set({
        files: [
          { path: 'src/a.mjs', status: 'modified', gate: false },
          { path: 'src/b.mjs', status: 'added', gate: false },
          { path: 'src/c.mjs', status: 'deleted', gate: false },
        ],
        total: 3,
      }),
    );
    expect(prompt).toContain('BUILDER CHANGES (since baseline abcdef12)');
    expect(prompt).toContain('M src/a.mjs');
    expect(prompt).toContain('A src/b.mjs');
    expect(prompt).toContain('D src/c.mjs');
    expect(prompt).not.toContain('GATE EDITS');
  });

  it('calls out gate edits and tells the critic what to do about them', () => {
    const prompt = compose(
      change_set({
        files: [
          { path: 'src/a.mjs', status: 'modified', gate: false },
          { path: 'test/a.test.mjs', status: 'deleted', gate: true },
        ],
        gate_edits: ['test/a.test.mjs'],
        total: 2,
      }),
    );
    expect(prompt).toContain('GATE EDITS (1)');
    expect(prompt).toContain('! test/a.test.mjs');
    expect(prompt).toContain('changes_requested');
  });

  it('says the builder changed nothing rather than staying silent', () => {
    const prompt = compose(change_set({ files: [], total: 0 }));
    expect(prompt).toContain('The builder changed no files');
  });

  it('names the truncation instead of implying a short list is the whole list', () => {
    const prompt = compose(change_set({ total: 431, truncated: true }));
    expect(prompt).toContain('showing 1 of 431 changed paths');
  });

  it('reads as "this run" when the repository has no baseline commit', () => {
    const prompt = compose(change_set({ baseline: null }));
    expect(prompt).toContain('BUILDER CHANGES (since this run)');
  });
});
