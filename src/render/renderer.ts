/**
 * Live output renderer: consumes `StreamChunk`s from each
 * `generate` call plus volley's own phase/cost lines, and writes human
 * progress to stderr. Streaming is a display concern only — the trajectory
 * jsonl is the durable record.
 */
import type { StreamChunk } from 'fascicle';
import type { RunResult } from '../types.js';
import {
  GLYPH_COST,
  GLYPH_ERR,
  GLYPH_OK,
  GLYPH_PHASE_FAIL,
  GLYPH_PHASE_OK,
  GLYPH_PHASE_START,
  GLYPH_TOOL,
  VERBOSE_TRUNCATE_CHARS,
  dim,
  format_usd,
  paint,
  summarize_value,
  truncate,
} from './format.js';
import type { Role } from './format.js';

export type RenderMode = 'default' | 'verbose' | 'quiet' | 'json';

export type RendererOptions = {
  mode: RenderMode;
  show_thinking: boolean;
  color: boolean;
  max_cost_usd: number | null;
  write?: (text: string) => void;
};

export type Renderer = {
  builder_chunk: (chunk: StreamChunk) => void;
  critic_chunk: (chunk: StreamChunk) => void;
  phase_start: (iteration: number, phase: Role) => void;
  phase_end: (iteration: number, phase: Role, ok: boolean, detail?: string) => void;
  cost_line: (iteration: number, phase: Role, phase_cost: number | null, run_total: number) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  final_summary: (result: RunResult) => void;
};

export function create_renderer(options: RendererOptions): Renderer {
  const write = options.write ?? ((text: string) => process.stderr.write(text));
  const { mode, color } = options;
  const silent = mode === 'json';
  const streaming = mode === 'default' || mode === 'verbose';

  // Tracks whether streamed prose left the cursor mid-line, so glyph lines
  // start on their own line.
  let mid_line = false;

  const line = (text: string): void => {
    if (silent) return;
    write(`${mid_line ? '\n' : ''}${text}\n`);
    mid_line = false;
  };

  const chunk_renderer = (role: Role) => (chunk: StreamChunk): void => {
    if (!streaming) return;
    switch (chunk.kind) {
      case 'text': {
        write(paint(role, chunk.text, color));
        mid_line = !chunk.text.endsWith('\n');
        return;
      }
      case 'reasoning': {
        if (!options.show_thinking) return;
        write(dim(chunk.text, color));
        mid_line = !chunk.text.endsWith('\n');
        return;
      }
      case 'tool_call_end': {
        const summary =
          mode === 'verbose'
            ? truncate(
                JSON.stringify(chunk.input, null, 2) ?? '',
                VERBOSE_TRUNCATE_CHARS,
                'see .volley/trajectory.jsonl',
              )
            : summarize_value(chunk.input);
        line(`${GLYPH_TOOL} ${paint(role, chunk.id, color)} ${summary}`);
        return;
      }
      case 'tool_result': {
        const ok = chunk.error === undefined;
        if (mode === 'verbose') {
          const body = ok ? summarize_output(chunk.output) : chunk.error?.message ?? '';
          line(`${ok ? GLYPH_OK : GLYPH_ERR} ${truncate(body, VERBOSE_TRUNCATE_CHARS, 'see .volley/trajectory.jsonl')}`);
        } else {
          line(`${ok ? GLYPH_OK : GLYPH_ERR} ${ok ? '' : summarize_value(chunk.error?.message)}`);
        }
        return;
      }
      case 'tool_call_start': {
        line(`${GLYPH_TOOL} ${paint(role, chunk.name, color)} …`);
        return;
      }
      default:
        return;
    }
  };

  return {
    builder_chunk: chunk_renderer('builder'),
    critic_chunk: chunk_renderer('critic'),
    phase_start: (iteration, phase) => {
      if (mode === 'json') return;
      line(paint(phase, `${GLYPH_PHASE_START} [iter ${String(iteration)}] ${phase}`, color));
    },
    phase_end: (iteration, phase, ok, detail) => {
      if (mode === 'json') return;
      const glyph = ok ? GLYPH_PHASE_OK : GLYPH_PHASE_FAIL;
      const suffix = detail !== undefined ? ` — ${detail}` : '';
      line(paint(phase, `${glyph} [iter ${String(iteration)}] ${phase}${suffix}`, color));
    },
    cost_line: (iteration, phase, phase_cost, run_total) => {
      if (mode === 'json') return;
      const cap = options.max_cost_usd !== null ? ` / ${format_usd(options.max_cost_usd)}` : '';
      line(
        paint(
          'cost',
          `${GLYPH_COST} [iter ${String(iteration)}] [${phase}] phase: ${format_usd(phase_cost)} | run: ${format_usd(run_total)}${cap}`,
          color,
        ),
      );
    },
    info: (message) => {
      line(message);
    },
    warn: (message) => {
      line(paint('critic', `warning: ${message}`, color));
    },
    error: (message) => {
      if (silent) {
        // Errors still surface in json mode — stderr stays human, stdout machine.
        write(`error: ${message}\n`);
        return;
      }
      line(paint('error', `error: ${message}`, color));
    },
    final_summary: (result) => {
      if (silent) return;
      line('');
      line(`run ${result.run_id}: ${result.status}`);
      line(
        `iterations: ${String(result.iterations_completed)} | verdict: ${result.final_verdict ?? 'n/a'}`,
      );
      line(
        paint(
          'cost',
          `${GLYPH_COST} total: ${format_usd(result.total_cost_usd)} (builder ${format_usd(result.builder_cost_usd)}, critic ${format_usd(result.critic_cost_usd)})`,
          color,
        ),
      );
      line(
        `tokens: ${String(result.total_usage.input_tokens)} in / ${String(result.total_usage.output_tokens)} out`,
      );
    },
  };
}

function summarize_output(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output) ?? '';
  } catch {
    return String(output);
  }
}
