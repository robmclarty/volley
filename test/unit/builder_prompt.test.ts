import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { run } from 'fascicle';
import { acp_seat_tools } from '../../src/acp_tools.js';
import {
  builder_presets_dir,
  compose_builder_prompt,
  compose_builder_system,
  compose_builder_system_local,
  make_builder_step,
  PREVIOUS_CHECK_MAX_CHARS,
} from '../../src/builder.js';
import type { BuilderDeps } from '../../src/builder.js';
import { skipped_check } from '../../src/check/command.js';
import type { BuilderProvider, CheckResult } from '../../src/types.js';
import { acp_session, temp_workspace, test_config } from '../helpers/harness.js';
import { mock_engine } from '../helpers/mock_engine.js';

const base = {
  task: 'implement the widget',
  criteria: '- widget works',
  feedback: null,
  iteration: 1,
  checkride: false,
  previous: null,
};

/** A red checkride run, as `run_checkride` returns it. */
function failed_checkride(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    ran: true,
    runner: 'checkride',
    ok: false,
    exit_code: 1,
    duration_ms: 3041,
    failing_slots: ['types', 'lint'],
    detail: [
      { slot: 'types', path: '/ws/.check/types.stdout.txt', content: 'src/a.ts(3,1): error TS2322', truncated: false },
      { slot: 'lint', path: '/ws/.check/lint.json', content: '{"diagnostics":[]}', truncated: false },
    ],
    digest: '# checkride failure digest\n\n## types — tsc\n\n- src/a.ts:3 TS2322\n',
    ...overrides,
  };
}

describe('compose_builder_prompt', () => {
  it('first iteration has no feedback section', () => {
    const prompt = compose_builder_prompt(base);
    expect(prompt).toContain('TASK');
    expect(prompt).toContain('implement the widget');
    expect(prompt).toContain('ACCEPTANCE CRITERIA');
    expect(prompt).toContain('- widget works');
    expect(prompt).toContain('ITERATION: 1');
    expect(prompt).not.toContain('PREVIOUS CRITIC FEEDBACK');
    expect(prompt).not.toContain('pnpm check');
  });

  it('later iterations embed the critic feedback verbatim', () => {
    const prompt = compose_builder_prompt({
      ...base,
      iteration: 2,
      feedback: '- the widget is broken\n- fix the spinner',
    });
    expect(prompt).toContain('ITERATION: 2');
    expect(prompt).toContain('PREVIOUS CRITIC FEEDBACK');
    expect(prompt).toContain('- the widget is broken\n- fix the spinner');
    expect(prompt).toContain('workspace already contains your prior work');
  });

  it('includes the checkride stanza only when checkride is the runner', () => {
    const with_checkride = compose_builder_prompt({ ...base, checkride: true }).replace(/\s+/g, ' ');
    // One call shows every failing slot's first findings, so a look at the
    // gate costs no more than a bare test run.
    expect(with_checkride).toContain('Run `pnpm check --digest` after each batch of edits and again before you finish');
    expect(with_checkride).toContain('read .check/digest.md first');

    const without = compose_builder_prompt(base);
    expect(without).not.toContain('pnpm check');
    expect(without).not.toContain('.check/digest.md');
  });

  it('iteration > 1 with null feedback omits the feedback section', () => {
    const prompt = compose_builder_prompt({ ...base, iteration: 3, feedback: null });
    expect(prompt).not.toContain('PREVIOUS CRITIC FEEDBACK');
  });
});

describe('compose_builder_prompt: the previous round', () => {
  const later = { ...base, iteration: 2, feedback: '- fix the types' };

  it("shows a failed check's slots, exit code, and checkride's digest after the critic's feedback", () => {
    const prompt = compose_builder_prompt({
      ...later,
      previous: { check: failed_checkride(), step_limit_hit: null },
    });
    expect(prompt).toContain('PREVIOUS CHECK RESULT');
    expect(prompt).toContain('The check failed on the work your last session left (checkride, exit 1).');
    expect(prompt).toContain('Failing slots: types, lint.');
    expect(prompt).toContain('- src/a.ts:3 TS2322');
    // The digest stands in for the raw artifacts, which stay the critic's.
    expect(prompt).not.toContain('{"diagnostics":[]}');
    expect(prompt.indexOf('PREVIOUS CRITIC FEEDBACK')).toBeLessThan(prompt.indexOf('PREVIOUS CHECK RESULT'));
  });

  it("falls back to each failing slot's raw output, named by its file, when there is no digest", () => {
    const { digest: _digest, ...check } = failed_checkride();
    const prompt = compose_builder_prompt({ ...later, previous: { check, step_limit_hit: null } });
    expect(prompt).toContain('types (.check/types.stdout.txt):\nsrc/a.ts(3,1): error TS2322');
    expect(prompt).toContain('lint (.check/lint.json):\n{"diagnostics":[]}');
  });

  it("shows the end of a command check's output, where its summary is", () => {
    const log = `${'noise\n'.repeat(2000)}FAIL test/widget.test.ts > spins\n`;
    const check: CheckResult = {
      ran: true,
      runner: 'command',
      ok: false,
      exit_code: 2,
      duration_ms: 10,
      failing_slots: [],
      detail: [],
      log,
    };
    const prompt = compose_builder_prompt({ ...later, previous: { check, step_limit_hit: null } });
    expect(prompt).toContain('The check failed on the work your last session left (exit 2).');
    expect(prompt).not.toContain('Failing slots');
    expect(prompt).toContain(`… (the last ${String(PREVIOUS_CHECK_MAX_CHARS)} characters of ${String(log.trimEnd().length)})`);
    expect(prompt).toContain('FAIL test/widget.test.ts > spins');
  });

  it('caps the excerpt and says where the rest is', () => {
    const digest = `# checkride failure digest\n${'- finding\n'.repeat(1000)}`;
    const prompt = compose_builder_prompt({
      ...later,
      previous: { check: failed_checkride({ digest }), step_limit_hit: null },
    });
    expect(prompt).toContain(
      `… (cut at ${String(PREVIOUS_CHECK_MAX_CHARS)} characters; .check/digest.md has the rest)`,
    );
    const section = prompt.slice(prompt.indexOf('PREVIOUS CHECK RESULT'));
    expect(section.length).toBeLessThan(PREVIOUS_CHECK_MAX_CHARS + 400);
  });

  it('says nothing of a check that passed or never ran, or on the first iteration', () => {
    const passed = { ...failed_checkride(), ok: true, exit_code: 0, failing_slots: [] };
    for (const check of [passed, skipped_check('cost_cap'), skipped_check('none'), null]) {
      const prompt = compose_builder_prompt({ ...later, previous: { check, step_limit_hit: null } });
      expect(prompt).not.toContain('PREVIOUS CHECK RESULT');
    }
    const first = compose_builder_prompt({
      ...base,
      previous: { check: failed_checkride(), step_limit_hit: 50 },
    });
    expect(first).not.toContain('PREVIOUS CHECK RESULT');
    expect(first).not.toContain('step limit');
  });

  it('tells the builder its last session ran out of steps, and to check first', () => {
    const prompt = compose_builder_prompt({
      ...later,
      previous: { check: null, step_limit_hit: 50 },
    }).replace(/\s+/g, ' ');
    expect(prompt).toContain('Your last session hit its 50-step limit before it called finish');
    expect(prompt).toContain('Run the check first this time');

    const stopped = compose_builder_prompt({ ...later, previous: { check: null, step_limit_hit: null } });
    expect(stopped).not.toContain('step limit');
  });
});

describe('compose_builder_system_local', () => {
  // Assertions run on whitespace-flattened text so the preset's markdown can
  // be re-wrapped without breaking phrase matches.
  const flat = compose_builder_system_local().replace(/\s+/g, ' ');

  it('ships the local preset, discoverable by listing', () => {
    expect(readdirSync(builder_presets_dir())).toContain('harness_append_local.md');
  });

  it('names every tool in the volley builder set', () => {
    const tools = [
      'read_file',
      'search_files',
      'list_files',
      'write_file',
      'edit_file',
      'bash',
      'fetch',
      'finish',
    ];
    for (const name of tools) {
      expect(flat).toContain(name);
    }
  });

  it('states the workspace-is-cwd convention', () => {
    expect(flat).toContain('The workspace is your current working directory');
    expect(flat).toContain('workspace-relative');
  });

  it('states that a successful finish call ends the turn', () => {
    expect(flat).toContain('finish call ends your turn');
    expect(flat).toContain('the harness stops the loop');
  });

  it('states the whole-file fallback for repeated edit_file failures', () => {
    expect(flat).toContain('If edit_file fails repeatedly on the same file');
    expect(flat).toContain('rewrite the whole file with write_file');
  });

  it('instructs stating a plan before the first tool call', () => {
    expect(flat).toContain('Plan first');
    expect(flat).toContain('before your first tool call, state your plan');
  });

  it('asks for a check after each batch of edits, not only before finishing', () => {
    for (const tool_set of ['volley', 'acp'] as const) {
      const prompt = compose_builder_system_local(tool_set).replace(/\s+/g, ' ');
      expect(prompt, tool_set).toContain('5. Verify as you go');
      expect(prompt, tool_set).toContain('after each batch of edits and again before finishing');
    }
  });
});

describe('compose_builder_system_local: tool calls per turn', () => {
  const flat = (tool_set: 'volley' | 'acp', calls?: number) =>
    compose_builder_system_local(tool_set, calls).replace(/\s+/g, ' ');

  it('asks for one call at a time at the default cap, and for batched reads above it', () => {
    for (const tool_set of ['volley', 'acp'] as const) {
      expect(flat(tool_set)).toContain('2. Call one tool at a time and read its result');
      const batched = flat(tool_set, 4);
      // Both presets word step 2 the same, so a rewording of either that the
      // replacement no longer matches shows up here.
      expect(batched, tool_set).not.toContain('Call one tool at a time');
      expect(batched).toContain(
        '2. Batch independent reads into one turn, up to 4 calls, but make one change or command per turn',
      );
      expect(batched).toContain('3. Read before you edit');
    }
  });
});

describe('compose_builder_system_local: the acp set', () => {
  const flat = compose_builder_system_local('acp').replace(/\s+/g, ' ');

  it('ships the acp preset beside the local one', () => {
    expect(readdirSync(builder_presets_dir())).toContain('harness_append_acp.md');
  });

  it("names fascicle's workspace tools and volley's finish", () => {
    for (const call of [
      'read_file(path, offset?, limit?)',
      'list_files(pattern?, path?)',
      'search(pattern, path?, glob?)',
      'write_file(path, content)',
      'edit_file(path, old_text, new_text, replace_all?)',
      'run_command(command, timeout_ms?)',
      'finish(summary)',
    ]) {
      expect(flat).toContain(call);
    }
  });

  it("names none of volley's own tools, which the acp builder doesn't hold", () => {
    for (const absent of ['bash(', 'search_files', 'fetch(', 'old_str']) {
      expect(flat).not.toContain(absent);
    }
  });

  it('says what a refused call means and what to do about it', () => {
    expect(flat).toContain('tool_approval_denied means the user said no');
    expect(flat).toContain("Don't repeat that call, and don't reach the same result another way");
    expect(flat).toContain('call finish with a summary that names what was refused');
  });

  it('keeps the local preset\'s identity, finish stop, and plan-first rule', () => {
    expect(flat).toContain('You are the builder inside the volley harness');
    expect(flat).toContain('finish call ends your turn');
    expect(flat).toContain('before your first tool call, state your plan');
  });
});

describe("the builder seat's system prompt", () => {
  /** The system prompt a builder seat's call carries, given the seat's
   * injected deps. */
  async function seat_system(
    builder_provider: BuilderProvider,
    seat: Pick<BuilderDeps, 'tools' | 'tool_set'> = {},
  ): Promise<string | undefined> {
    const { workspace, cleanup } = temp_workspace();
    try {
      const engine = mock_engine(() => ({ content: 'done' }));
      const config = test_config({ workspace, builder_provider, builder_model: 'builder-model' });
      const step = make_builder_step({ engine, config, on_chunk: () => undefined, ...seat });
      await run(step, 'build it', { install_signal_handlers: false });
      return engine.calls[0]?.opts.system;
    } finally {
      cleanup();
    }
  }

  it("is today's prompt, byte for byte, for a seat with no injected set", async () => {
    const today = [
      'You are the builder inside the volley harness: an autonomous agent',
      'iterating on a workspace until it satisfies a task and its acceptance',
      'criteria.',
      '',
      readFileSync(join(builder_presets_dir(), 'harness_append_local.md'), 'utf8').trimEnd(),
    ].join('\n');
    for (const provider of ['ollama', 'lmstudio', 'openrouter'] as const) {
      expect(await seat_system(provider)).toBe(today);
      expect(await seat_system(provider, { tool_set: 'volley' })).toBe(today);
    }
    expect(compose_builder_system_local()).toBe(today);
  });

  it('is the acp preset for a seat holding the acp set', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const { builder } = acp_seat_tools(acp_session(workspace));
      const system = await seat_system('openrouter', builder);
      expect(system).toBe(compose_builder_system_local('acp'));
      expect(system).toContain('run_command');
      expect(system).toContain('search(');
      expect(system).toContain('tool_approval_denied');
    } finally {
      cleanup();
    }
  });

  it('stays the CLI prompt for a claude_cli seat, which takes no injected set', async () => {
    expect(await seat_system('claude_cli', { tools: [], tool_set: 'acp' })).toBe(
      compose_builder_system(),
    );
  });
});

describe('claude_cli builder system prompt (unchanged)', () => {
  it('is byte-for-byte the v2 prompt', () => {
    expect(compose_builder_system()).toBe(
      [
        'You are the builder inside the volley harness: an autonomous agent',
        'iterating on a workspace until it satisfies a task and its acceptance',
        'criteria. Work directly in the current working directory. Plan',
        'internally, make the changes, and verify your own work before finishing.',
      ].join('\n'),
    );
  });

  it('does not name the local tool set', () => {
    const prompt = compose_builder_system();
    for (const name of ['read_file', 'write_file', 'edit_file']) {
      expect(prompt).not.toContain(name);
    }
  });
});

describe('publish surface', () => {
  it('package.json files ships both preset directories', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    ) as { files: string[] };
    expect(pkg.files).toContain('src/builder/presets');
    expect(pkg.files).toContain('src/critic/presets');
  });
});
