import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_USAGE } from '../../src/cost.js';
import {
  build_run_summary,
  transport_of,
  write_run_summary,
} from '../../src/summary.js';
import type { RunResult, RunStatus } from '../../src/types.js';
import { test_config, temp_workspace } from '../helpers/harness.js';

/** Write a per-iteration archive the way `archive_iteration` does, so the
 * summary reads a real on-disk shape. */
function archive(
  workspace: string,
  iteration: number,
  fields: {
    tool_calls?: number;
    salvaged?: number;
    check_ran?: boolean;
    check_ok?: boolean;
    failing_slots?: string[];
  },
): void {
  const dir = join(workspace, '.volley', 'iterations', String(iteration).padStart(3, '0'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'summary.json'),
    JSON.stringify({
      iteration,
      builder:
        fields.tool_calls === undefined
          ? null
          : { tool_calls: fields.tool_calls, salvaged_tool_calls: fields.salvaged ?? 0 },
      check:
        fields.check_ran === undefined
          ? null
          : { ran: fields.check_ran, ok: fields.check_ok ?? false, failing_slots: fields.failing_slots ?? [] },
    }),
  );
}

function run_result(overrides: Partial<RunResult> = {}): RunResult {
  return {
    run_id: 'test-run-id',
    status: 'success' satisfies RunStatus,
    started_at: '2026-07-15T00:00:00.000Z',
    completed_at: '2026-07-15T00:01:30.000Z',
    iterations_completed: 2,
    total_usage: EMPTY_USAGE,
    total_cost_usd: 0.42,
    builder_cost_usd: 0.3,
    critic_cost_usd: 0.12,
    check_duration_ms: 4200,
    final_verdict: 'approved',
    salvaged_branch: null,
    ...overrides,
  };
}

describe('transport_of', () => {
  it('maps claude_cli to its CLI transport and the local providers to ai_sdk', () => {
    expect(transport_of('claude_cli')).toBe('claude_cli');
    expect(transport_of('ollama')).toBe('ai_sdk');
    expect(transport_of('lmstudio')).toBe('ai_sdk');
  });
});

describe('build_run_summary', () => {
  it('folds the seven comparison metrics onto the run result', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      mkdirSync(join(workspace, '.volley'), { recursive: true });
      archive(workspace, 1, { tool_calls: 4, salvaged: 1, check_ran: true, check_ok: false, failing_slots: ['types'] });
      archive(workspace, 2, { tool_calls: 6, salvaged: 2, check_ran: true, check_ok: true });
      const config = test_config({ workspace, builder_provider: 'ollama', critic_provider: 'ollama' });

      const { comparison } = build_run_summary(config, run_result());

      expect(comparison.builder_transport).toBe('ai_sdk');
      expect(comparison.critic_transport).toBe('ai_sdk');
      expect(comparison.iterations_to_converge).toBe(2);
      expect(comparison.wall_clock_ms).toBe(90_000);
      expect(comparison.total_cost_usd).toBe(0.42);
      expect(comparison.final_verdict).toBe('approved');
      expect(comparison.check_trajectory).toEqual([
        { iteration: 1, ran: true, ok: false, failing_slots: ['types'] },
        { iteration: 2, ran: true, ok: true, failing_slots: [] },
      ]);
      // 3 of 10 builder tool calls were salvaged across the run.
      expect(comparison.local_salvage).toEqual({ tool_calls: 10, salvaged_tool_calls: 3, rate: 0.3 });
    } finally {
      cleanup();
    }
  });

  it('leaves converge/wall-clock null when the run did not converge', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      mkdirSync(join(workspace, '.volley'), { recursive: true });
      const config = test_config({ workspace });
      const { comparison } = build_run_summary(
        config,
        run_result({ status: 'budget_exhausted', completed_at: null, final_verdict: null }),
      );
      expect(comparison.iterations_to_converge).toBeNull();
      expect(comparison.wall_clock_ms).toBeNull();
      // No archives, a claude_cli builder that reports no tool calls: salvage is 0, not NaN.
      expect(comparison.local_salvage).toEqual({ tool_calls: 0, salvaged_tool_calls: 0, rate: 0 });
      expect(comparison.check_trajectory).toEqual([]);
      expect(comparison.builder_transport).toBe('claude_cli');
    } finally {
      cleanup();
    }
  });
});

describe('write_run_summary', () => {
  it('writes the enriched summary to .volley/summary.json', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      mkdirSync(join(workspace, '.volley'), { recursive: true });
      const config = test_config({ workspace });
      write_run_summary(config, run_result());
      const written = JSON.parse(readFileSync(join(workspace, '.volley', 'summary.json'), 'utf8'));
      // The RunResult top level survives (load_resume_state still reads it)...
      expect(written.run_id).toBe('test-run-id');
      expect(written.status).toBe('success');
      // ...alongside the comparison block.
      expect(written.comparison.iterations_to_converge).toBe(2);
    } finally {
      cleanup();
    }
  });
});
