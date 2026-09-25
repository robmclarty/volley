/**
 * Opt-in live tests: VOLLEY_LIVE=1 pnpm test
 *
 * live_smoke drives the real `claude` CLI once; live_checkride_smoke runs the
 * real checkride binary against a minimal fixture workspace; live_local_builder
 * drives a phase-sized task through a real local builder provider. All are
 * skipped by default — they cost money and/or require local tooling.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { run_checkride } from '../../src/check/checkride.js';
import { create_volley_engine } from '../../src/engine.js';
import { run_volley } from '../../src/orchestrator.js';
import type { BuilderProvider } from '../../src/types.js';
import { silent_renderer, temp_workspace, test_config } from '../helpers/harness.js';

const LIVE = process.env['VOLLEY_LIVE'] === '1';

// The local-builder live path needs a running Ollama/LM Studio serving a
// pinned tool-capable model, so it gates on an extra opt-in beyond VOLLEY_LIVE:
// name the provider (and optionally the model) that is actually up locally.
const LIVE_BUILDER_PROVIDER = process.env['VOLLEY_LIVE_BUILDER_PROVIDER'];
const LIVE_LOCAL_BUILDER =
  LIVE && (LIVE_BUILDER_PROVIDER === 'ollama' || LIVE_BUILDER_PROVIDER === 'lmstudio');
const LIVE_BUILDER_MODEL = process.env['VOLLEY_LIVE_BUILDER_MODEL'] ?? 'qwen3-coder:30b';

describe.runIf(LIVE)('live_smoke (real claude CLI)', () => {
  it('one-iteration run wires argv, schema output, and cost end to end', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const config = test_config({
        workspace,
        prompt: 'Create a file named hello.txt containing exactly: hello volley',
        criteria: 'hello.txt exists and contains "hello volley"',
        builder_model: 'haiku',
        critic_model: 'haiku',
        max_iterations: 1,
        max_cost_usd: 2,
      });
      const engine = create_volley_engine({ workspace });
      const result = await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });
      // One iteration may or may not satisfy the critic; both are valid runs.
      expect(['success', 'budget_exhausted']).toContain(result.status);
      expect(result.iterations_completed).toBe(1);
      expect(result.total_cost_usd).toBeGreaterThan(0);
      expect(existsSync(join(workspace, 'hello.txt'))).toBe(true);
      expect(existsSync(join(workspace, '.volley', 'trajectory.jsonl'))).toBe(true);

      // The all-Claude critic's structured verdict survived the trip
      // through `claude --json-schema`. The critic ran `verdict_schema` there
      // this iteration; it only compiles because fascicle 0.12.13's
      // `compile_schema` strips the top-level `$schema`/`$id` that zod v4 stamps
      // (the CLI rejects them). A non-null verdict on the claude_cli critic is
      // the tripwire that keeps that fix honest — a future fascicle regression
      // would throw in `run_critic` and fail this run.
      const summary = JSON.parse(
        readFileSync(join(workspace, '.volley', 'iterations', '001', 'summary.json'), 'utf8'),
      );
      expect(summary.critic.provider).toBe('claude_cli');
      expect(['approved', 'changes_requested']).toContain(summary.verdict);
    } finally {
      cleanup();
    }
  }, 600000);
});

describe.runIf(LIVE_LOCAL_BUILDER)('live_local_builder (real local provider)', () => {
  it('drives a phase-sized task through the volley tool loop and the outer loop treats it like a claude_cli build', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      // A minimal, offline `pnpm check` the builder can self-verify against
      // with its bash tool: `node --check` parses the file it must create, so
      // the check is red until the builder writes valid syntax.
      writeFileSync(
        join(workspace, 'package.json'),
        JSON.stringify({ name: 'live-builder-fixture', type: 'module', scripts: { check: 'node --check sum.js' } }),
      );

      const provider = LIVE_BUILDER_PROVIDER as BuilderProvider;
      const config = test_config({
        workspace,
        prompt:
          'Create a file `sum.js` that exports `export function sum(a, b) { return a + b }`. ' +
          'Then run `pnpm check` with the bash tool to verify it parses, and call finish once the check passes.',
        criteria: 'sum.js exists, exports a `sum` function, and `pnpm check` passes.',
        check: 'pnpm check',
        check_resolved: 'command',
        // Fully local, offline, free: builder and critic both on the local
        // provider so the run needs no Claude auth and costs nothing.
        builder_provider: provider,
        builder_model: LIVE_BUILDER_MODEL,
        critic_provider: provider,
        critic_model: LIVE_BUILDER_MODEL,
        allow_unsandboxed_builder: true,
        max_iterations: 2,
      });
      const engine = create_volley_engine({
        workspace,
        builder_provider: provider,
        critic_provider: provider,
      });
      const result = await run_volley(config, {
        renderer: silent_renderer(),
        engine,
        install_signal_handlers: false,
      });

      // The outer loop ran the local build exactly like a claude_cli one:
      // a real workspace, a check pass, and a critic verdict — not an error.
      expect(['success', 'budget_exhausted']).toContain(result.status);
      expect(result.iterations_completed).toBeGreaterThanOrEqual(1);
      expect(existsSync(join(workspace, 'sum.js'))).toBe(true);
      expect(existsSync(join(workspace, '.volley', 'trajectory.jsonl'))).toBe(true);
      // Local providers are free — the whole run costs nothing.
      expect(result.total_cost_usd).toBe(0);

      const summary = JSON.parse(
        readFileSync(join(workspace, '.volley', 'iterations', '001', 'summary.json'), 'utf8'),
      );
      // The builder went through volley's tool loop on the local provider and
      // terminated the normal way (a `finish` stop or the max_steps backstop).
      expect(summary.builder.provider).toBe(provider);
      expect(['stop', 'max_steps']).toContain(summary.builder.finish_reason);
      // The produced workspace was handed to check + critic like any build.
      expect(summary.check.ran).toBe(true);
      // The local critic returned a structured verdict via Ollama
      // constrained decode (`verdict_schema`, fascicle's ai_sdk default) — the
      // other half of the two schema paths, unchanged in v3.
      expect(summary.critic.provider).toBe(provider);
      expect(['approved', 'changes_requested']).toContain(summary.verdict);
    } finally {
      cleanup();
    }
  }, 600000);
});

describe.runIf(LIVE)('live_checkride_smoke (real checkride)', () => {
  it('parses the real --json summary against schema_version 1', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      // Minimal pnpm-style workspace: a shim to the repo's own pinned
      // checkride, plus one config-only custom check that always passes.
      const repo_root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
      const checkride_cli = join(repo_root, 'node_modules', 'checkride', 'dist', 'cli.js');
      writeFileSync(
        join(workspace, 'package.json'),
        JSON.stringify({ name: 'live-fixture', type: 'module' }),
      );
      writeFileSync(
        join(workspace, 'checkride.config.json'),
        JSON.stringify({ checks: { smoke: { command: 'true', description: 'always green' } } }),
      );
      const bin_dir = join(workspace, 'node_modules', '.bin');
      mkdirSync(bin_dir, { recursive: true });
      const bin = join(bin_dir, 'checkride');
      writeFileSync(bin, `#!/bin/sh\nexec node "${checkride_cli}" "$@"\n`);
      chmodSync(bin, 0o755);

      const result = await run_checkride({ workspace });
      expect(result.ran).toBe(true);
      expect(result.runner).toBe('checkride');
      expect(result.ok).toBe(true);
      expect((result.summary as { schema_version: number }).schema_version).toBe(1);
      expect(existsSync(join(workspace, '.check', 'summary.json'))).toBe(true);
    } finally {
      cleanup();
    }
  }, 120000);
});
