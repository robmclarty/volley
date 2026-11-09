import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from 'fascicle';
import { DEFAULT_GATE_PATTERNS } from '../../src/changes.js';
import {
  compose_tester_prompt,
  resolve_tester_prompt,
  tester_presets_dir,
} from '../../src/tester/prompt.js';
import { make_tester_step, tester_canary, tester_prompt } from '../../src/tester/run.js';
import { writable_gate_patterns } from '../../src/tester/tools.js';
import { temp_workspace, test_config } from '../helpers/harness.js';
import { mock_engine } from '../helpers/mock_engine.js';
import type { CriticProvider, ResolvedConfig } from '../../src/types.js';

describe('the tester prompt', () => {
  it('ships its preset with the package', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8')) as {
      files: string[];
    };
    expect(pkg.files).toContain('src/tester/presets');
    expect(readFileSync(join(tester_presets_dir(), 'tester.md'), 'utf8')).toContain(
      'You are the tester inside the volley harness',
    );
  });

  it("is the preset and the tools its seat holds: volley's own, or the CLI's", () => {
    const preset = readFileSync(join(tester_presets_dir(), 'tester.md'), 'utf8').trimEnd();
    const local = resolve_tester_prompt('ollama');
    expect(local.startsWith(`${preset}\n\n`)).toBe(true);
    expect(local).toContain('write_file(path, content) and edit_file(path, old_str, new_str)');
    expect(local).toContain('You cannot run commands');
    const claude = resolve_tester_prompt('claude_cli');
    expect(claude.startsWith(`${preset}\n\n`)).toBe(true);
    expect(claude).toContain('Read, Grep and Glob');
    expect(claude).not.toContain('write_file');
  });

  it('composes from the criteria, where it may write, the check and the inventory', () => {
    const prompt = compose_tester_prompt({
      criteria: 'balance() sums the postings',
      writable: ['**/test/**', '**/*.test.*'],
      check: 'node --test',
      inventory: 'src/ledger.js (12 bytes)',
    });
    expect(prompt).toContain('ACCEPTANCE CRITERIA\n-------------------\nbalance() sums the postings');
    expect(prompt).toContain('  **/test/**\n  **/*.test.*');
    expect(prompt).toContain('except package.json, *.config.* files and\nanything under .github/');
    expect(prompt).toContain('`node --test` runs once you finish. It must fail then, on your test.');
    expect(prompt).toContain('WORKSPACE FILE INVENTORY\n------------------------\nsrc/ledger.js (12 bytes)');
    expect(compose_tester_prompt({ criteria: 'c', writable: [], check: 'auto', inventory: '' })).toContain(
      'checkride, found by --check auto runs once you finish',
    );
  });

  it("reads the run's criteria, gate and build root", () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      writeFileSync(join(workspace, 'ledger.js'), 'x');
      const prompt = tester_prompt(
        test_config({ workspace, criteria: 'the books balance', check: 'node --test' }),
      );
      expect(prompt).toContain('the books balance');
      expect(prompt).toContain('ledger.js (1 bytes)');
      for (const pattern of writable_gate_patterns(DEFAULT_GATE_PATTERNS)) {
        expect(prompt).toContain(`  ${pattern}\n`);
      }
      expect(prompt).not.toContain('**/package.json');
    } finally {
      cleanup();
    }
  });
});

describe('the tester call', () => {
  async function tester_call(overrides: Partial<ResolvedConfig>, workspace: string) {
    const engine = mock_engine(() => ({ content: 'wrote test/ledger.test.js' }));
    const config = test_config({ workspace, tester: true, critic_model: 'critic-model', ...overrides });
    await run(make_tester_step({ engine, config, on_chunk: () => undefined }), 'write it', {
      install_signal_handlers: false,
    });
    const [call] = engine.calls;
    if (call === undefined) throw new Error('no call');
    return call.opts;
  }

  it("runs on the critic's provider and model at the critic's effort, with volley's tester tools", async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const opts = await tester_call(
        { critic_provider: 'ollama' as CriticProvider, critic_effort: 'high' },
        workspace,
      );
      expect(opts).toMatchObject({ provider: 'ollama', model: 'critic-model', effort: 'high' });
      expect(opts.system).toBe(resolve_tester_prompt('ollama'));
      expect(opts.tools?.map((tool) => tool.name)).toEqual([
        'read_file',
        'search_files',
        'list_files',
        'write_file',
        'edit_file',
      ]);
      expect(opts).toMatchObject({ tool_error_policy: 'feed_back', max_tool_calls_per_step: 1 });
      expect(opts.provider_options).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('takes --tester-model over the critic, and sends no effort when the critic has none', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const opts = await tester_call({ tester_model: 'tester-model' }, workspace);
      expect(opts.model).toBe('tester-model');
      expect(opts).not.toHaveProperty('effort');
    } finally {
      cleanup();
    }
  });

  it('on claude_cli, runs under its own permission list in the default mode, with no tools of volley', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const opts = await tester_call({ critic_provider: 'claude_cli' }, workspace);
      expect(opts.tools).toBeUndefined();
      const claude = (opts.provider_options as { claude_cli: { allowed_tools: string[]; extra_args: string[] } })
        .claude_cli;
      expect(claude.allowed_tools[0]).toBe('Read(/**)');
      expect(claude.allowed_tools).toContain('Edit(/**/test/**)');
      expect(claude.allowed_tools).not.toContain('Edit(/**/package.json)');
      expect(claude.extra_args.slice(0, 2)).toEqual([
        '--disallowedTools',
        'Bash,NotebookEdit,Edit(/**/package.json),Edit(/**/*.config.*),Edit(/**/.github/**)',
      ]);
      expect(claude.extra_args).toContain('--settings');
      expect(claude.extra_args).not.toContain('--permission-mode');
    } finally {
      cleanup();
    }
  });
});

describe('tester_canary', () => {
  it('asks for a read through read tools only, so a dry run writes nothing', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const engine = mock_engine(() => ({ content: 'canary' }));
      const config = test_config({ workspace, tester: true, critic_provider: 'lmstudio' });
      expect(await tester_canary(engine, config, {})).toEqual({ outcome: 'ok' });
      expect(engine.calls[0]?.opts.tools?.map((tool) => tool.name)).toEqual([
        'read_file',
        'search_files',
        'list_files',
      ]);
    } finally {
      cleanup();
    }
  });

  it('reports a failed call, naming why', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const engine = mock_engine(() => ({ content: '', error: new Error('model not found') }));
      const config = test_config({ workspace, tester: true, critic_provider: 'lmstudio' });
      expect(await tester_canary(engine, config, {})).toEqual({
        outcome: 'failed',
        detail: 'model not found',
      });
    } finally {
      cleanup();
    }
  });
});
