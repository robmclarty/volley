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
import type { CheckResult } from '../../src/types.js';

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
    const prompt = compose_critic_prompt({ criteria: '- it works', iteration: 2, check });
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
    const prompt = compose_critic_prompt({ criteria: 'c', iteration: 1, check });
    expect(prompt).toContain('widget spins backwards');
  });
});
