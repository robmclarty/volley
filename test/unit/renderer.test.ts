import { describe, expect, it } from 'vitest';
import type { StreamChunk } from 'fascicle';
import { create_renderer } from '../../src/render/renderer.js';
import type { RenderMode } from '../../src/render/renderer.js';
import type { RunResult } from '../../src/types.js';

const CHUNKS: StreamChunk[] = [
  { kind: 'text', text: 'Working on it.\n', step_index: 0 },
  { kind: 'reasoning', text: 'thinking hard\n', step_index: 0 },
  { kind: 'tool_call_start', id: 't1', name: 'Edit', step_index: 0 },
  { kind: 'tool_call_end', id: 't1', input: { file_path: '/tmp/x.ts' }, step_index: 0 },
  { kind: 'tool_result', id: 't1', output: 'ok', step_index: 0 },
  { kind: 'step_finish', step_index: 0, finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } },
];

const RESULT: RunResult = {
  run_id: 'r1',
  status: 'success',
  started_at: '2026-07-07T00:00:00Z',
  completed_at: '2026-07-07T00:01:00Z',
  iterations_completed: 2,
  total_usage: { input_tokens: 100, output_tokens: 40 },
  total_cost_usd: 1.5,
  builder_cost_usd: 1.2,
  critic_cost_usd: 0.3,
  check_duration_ms: 500,
  final_verdict: 'approved',
  salvaged_branch: null,
};

function capture(mode: RenderMode, show_thinking = true) {
  const lines: string[] = [];
  const renderer = create_renderer({
    mode,
    show_thinking,
    color: false,
    max_cost_usd: 20,
    write: (text) => lines.push(text),
  });
  return { renderer, output: () => lines.join('') };
}

describe('renderer', () => {
  it('default mode streams text and summarizes tool calls to one line', () => {
    const { renderer, output } = capture('default');
    for (const chunk of CHUNKS) renderer.builder_chunk(chunk);
    const text = output();
    expect(text).toContain('Working on it.');
    expect(text).toContain('thinking hard');
    expect(text).toContain('🔧');
    expect(text).toContain('file_path');
    expect(text).toContain('✅');
  });

  it('hides reasoning when show_thinking is false', () => {
    const { renderer, output } = capture('default', false);
    for (const chunk of CHUNKS) renderer.builder_chunk(chunk);
    expect(output()).not.toContain('thinking hard');
  });

  it('quiet mode shows phase and cost lines but no chunks', () => {
    const { renderer, output } = capture('quiet');
    for (const chunk of CHUNKS) renderer.builder_chunk(chunk);
    renderer.phase_start(1, 'builder');
    renderer.cost_line(1, 'builder', 0.218, 0.591);
    renderer.phase_end(1, 'builder', true);
    const text = output();
    expect(text).not.toContain('Working on it.');
    expect(text).toContain('▶ [iter 1] builder');
    expect(text).toContain('💰 [iter 1] [builder] phase: $0.218 | run: $0.591 / $20.000');
    expect(text).toContain('✓ [iter 1] builder');
  });

  it('json mode emits nothing except errors', () => {
    const { renderer, output } = capture('json');
    for (const chunk of CHUNKS) renderer.builder_chunk(chunk);
    renderer.phase_start(1, 'builder');
    renderer.cost_line(1, 'builder', 0.2, 0.2);
    renderer.final_summary(RESULT);
    expect(output()).toBe('');
    renderer.error('boom');
    expect(output()).toBe('error: boom\n');
  });

  it('verbose mode truncates oversized tool inputs with a pointer', () => {
    const { renderer, output } = capture('verbose');
    renderer.builder_chunk({
      kind: 'tool_call_end',
      id: 't2',
      input: { blob: 'y'.repeat(5000) },
      step_index: 0,
    });
    const text = output();
    expect(text).toContain('truncated at 4000 chars');
    expect(text).toContain('.volley/trajectory.jsonl');
  });

  it('final summary reports status, verdict, and costs', () => {
    const { renderer, output } = capture('default');
    renderer.final_summary(RESULT);
    const text = output();
    expect(text).toContain('run r1: success');
    expect(text).toContain('verdict: approved');
    expect(text).toContain('total: $1.500');
    expect(text).toContain('100 in / 40 out');
  });
});
