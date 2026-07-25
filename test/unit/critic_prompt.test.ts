import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compose_critic_prompt,
  presets_dir,
  resolve_critic_prompt,
} from '../../src/critic/prompt.js';
import { skipped_check } from '../../src/check/command.js';
import { temp_workspace, test_config } from '../helpers/harness.js';
import type { ChangeSet, CheckResult } from '../../src/types.js';

describe('presets', () => {
  it('ships one markdown file per preset, discoverable by listing', () => {
    const files = readdirSync(presets_dir());
    expect(files).toContain('reviewer.md');
    expect(files).toContain('optimizer.md');
    expect(files).toContain('researcher.md');
    expect(files).toContain('harness_append.md');
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
