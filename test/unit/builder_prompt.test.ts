import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compose_builder_prompt,
  compose_builder_system,
  compose_builder_system_local,
  presets_dir,
} from '../../src/builder.js';

const base = {
  task: 'implement the widget',
  criteria: '- widget works',
  feedback: null,
  iteration: 1,
  checkride: false,
};

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
    const with_checkride = compose_builder_prompt({ ...base, checkride: true });
    expect(with_checkride).toContain('pnpm check');
    expect(with_checkride).toContain('.check/summary.json');

    const without = compose_builder_prompt(base);
    expect(without).not.toContain('.check/summary.json');
  });

  it('iteration > 1 with null feedback omits the feedback section', () => {
    const prompt = compose_builder_prompt({ ...base, iteration: 3, feedback: null });
    expect(prompt).not.toContain('PREVIOUS CRITIC FEEDBACK');
  });
});

describe('compose_builder_system_local', () => {
  // Assertions run on whitespace-flattened text so the preset's markdown can
  // be re-wrapped without breaking phrase matches.
  const flat = compose_builder_system_local().replace(/\s+/g, ' ');

  it('ships the local preset, discoverable by listing', () => {
    expect(readdirSync(presets_dir())).toContain('harness_append_local.md');
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
