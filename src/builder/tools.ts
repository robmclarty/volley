/**
 * Builder tool set for local (non-CLI) builders (v3 s1, D2).
 *
 * A local model brings no built-in tools, so volley supplies the whole
 * agentic surface: the shared read-only trio (reused from
 * `src/workspace_tools.ts`, C4) plus `write_file`, `edit_file`, `bash`, and
 * the terminal `finish`. `fetch` joins in a later step. File paths are
 * confined to the workspace via `contain()`.
 *
 * Error semantics (D4/D10): a wrong-but-recoverable input — `edit_file`
 * matching 0 or N places, a `bash` command exiting non-zero or timing out —
 * is *returned* as a tool result the model reads and acts on. Tools throw
 * only on a genuine harness fault (containment violation, unreadable input,
 * over-cap write).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Tool } from 'fascicle';
import { contain, read_only_tools } from '../workspace_tools.js';

export const WRITE_FILE_MAX_BYTES = 1_000_000;

// Sized to fit a workspace `pnpm check`: volley's own checkride timeout is
// 600s (Q1), so a shorter budget would kill the builder's self-verify
// mid-run. Overridable per call site via `BuilderToolOptions` (tests use a
// short value so the timeout path is exercised without a 10-minute wait).
export const BASH_TIMEOUT_MS = 600_000;

// Model-facing cap on each of stdout/stderr; oversize output is truncated
// with a marker (D3 failure mode). Not a memory guard — `BASH_CAPTURE_MAX_BYTES`
// below bounds what `spawnSync` buffers before we ever truncate.
export const BASH_MAX_OUTPUT_BYTES = 100_000;

// OOM backstop on `spawnSync`'s captured output, well above the display cap:
// a command that floods gigabytes is bounded here, then truncated to the
// display cap for the model.
const BASH_CAPTURE_MAX_BYTES = 10_000_000;

export type BuilderToolOptions = {
  /** Override `BASH_TIMEOUT_MS` (ms). */
  bash_timeout_ms?: number;
  /** Override `BASH_MAX_OUTPUT_BYTES` (bytes, per stream). */
  bash_max_output_bytes?: number;
};

const write_file_input = z.object({
  path: z.string().describe('Workspace-relative path to write. Parent directories are created.'),
  content: z.string().describe('Full UTF-8 content of the file. Overwrites any existing content.'),
});

const edit_file_input = z.object({
  path: z.string().describe('Workspace-relative path of the file to edit.'),
  old_str: z
    .string()
    .min(1)
    .describe('Exact text to replace. Must occur exactly once in the file.'),
  new_str: z.string().describe('Replacement text.'),
});

const bash_input = z.object({
  command: z.string().describe('Shell command to run in the workspace directory.'),
});

const finish_input = z.object({
  summary: z.string().describe('Short summary of what was accomplished.'),
});

function count_occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Truncate `text` to at most `max` bytes, appending a marker when clipped.
 * Byte-based to honor the byte cap; a split multibyte char at the boundary
 * renders as the replacement char, which is acceptable for tool output. */
function truncate_bytes(text: string, max: number): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  const clipped = Buffer.from(text, 'utf8').subarray(0, max).toString('utf8');
  return `${clipped}\n… [truncated at ${String(max)} bytes]`;
}

// Same wiring convention as the shared read tools: each tool is typed as
// fascicle's `Tool` (input `unknown`) and re-parses the model's raw
// arguments with its own schema inside `execute`.
export function builder_tools(workspace: string, options: BuilderToolOptions = {}): Tool[] {
  const bash_timeout_ms = options.bash_timeout_ms ?? BASH_TIMEOUT_MS;
  const bash_max_output_bytes = options.bash_max_output_bytes ?? BASH_MAX_OUTPUT_BYTES;

  const write_file: Tool = {
    name: 'write_file',
    description:
      'Write a UTF-8 text file in the workspace, creating parent directories ' +
      'and overwriting any existing content. Rejects content over ' +
      `${String(WRITE_FILE_MAX_BYTES)} bytes.`,
    input_schema: write_file_input,
    execute: (raw) => {
      const input = write_file_input.parse(raw);
      const abs = contain(workspace, input.path);
      const bytes = Buffer.byteLength(input.content, 'utf8');
      if (bytes > WRITE_FILE_MAX_BYTES) {
        throw new Error(
          `content is ${String(bytes)} bytes, over the ${String(WRITE_FILE_MAX_BYTES)}-byte write cap`,
        );
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, input.content, 'utf8');
      return `wrote ${String(bytes)} bytes to ${input.path}`;
    },
  };

  const edit_file: Tool = {
    name: 'edit_file',
    description:
      'Replace one exact occurrence of old_str with new_str in a workspace ' +
      'file. old_str must match the file content exactly once — on 0 or ' +
      'multiple matches nothing is changed and an error is returned; read ' +
      'the file and retry with a longer, unique old_str.',
    input_schema: edit_file_input,
    execute: (raw) => {
      const input = edit_file_input.parse(raw);
      const abs = contain(workspace, input.path);
      const content = readFileSync(abs, 'utf8');
      const matches = count_occurrences(content, input.old_str);
      if (matches === 0) {
        return (
          `error: old_str not found in ${input.path} (0 matches). ` +
          'No change made. Read the file and retry with an exact excerpt of its current content.'
        );
      }
      if (matches > 1) {
        return (
          `error: old_str matches ${String(matches)} times in ${input.path}. ` +
          'No change made. Include more surrounding context to make old_str unique.'
        );
      }
      writeFileSync(abs, content.replace(input.old_str, input.new_str), 'utf8');
      return `edit applied to ${input.path}`;
    },
  };

  const bash: Tool = {
    name: 'bash',
    description:
      'Run a shell command in the workspace and return its exit code, stdout, ' +
      'and stderr. Each call is independent — no shell state (working ' +
      'directory, environment, variables) carries over between commands. A ' +
      'non-zero exit is a normal result, not an error: read it and adjust. ' +
      `Each stream is truncated past ${String(bash_max_output_bytes)} bytes, ` +
      `and the command is killed if it runs longer than ${String(bash_timeout_ms)}ms.`,
    input_schema: bash_input,
    // D3/D4: stateless per command (the exact seam Session 2 swaps to
    // `docker exec`), and never throws on the command's own failure — a
    // non-zero exit or a timeout is *returned* as `{ exit_code, stdout,
    // stderr }` for the model to read. `spawnSync` buffers up to
    // `BASH_CAPTURE_MAX_BYTES` (OOM guard) before we truncate to the
    // model-facing cap.
    execute: (raw) => {
      const input = bash_input.parse(raw);
      const result = spawnSync(input.command, {
        shell: true,
        cwd: workspace,
        encoding: 'utf8',
        timeout: bash_timeout_ms,
        killSignal: 'SIGKILL',
        maxBuffer: BASH_CAPTURE_MAX_BYTES,
      });
      const timed_out =
        (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
      let stderr = truncate_bytes(result.stderr ?? '', bash_max_output_bytes);
      if (timed_out) {
        const note = `[command timed out after ${String(bash_timeout_ms)}ms and was killed]`;
        stderr = stderr.length > 0 ? `${stderr}\n${note}` : note;
      }
      // `status` is the numeric exit code, or null when the process was
      // killed by a signal (e.g. the timeout SIGKILL above).
      return {
        exit_code: result.status,
        stdout: truncate_bytes(result.stdout ?? '', bash_max_output_bytes),
        stderr,
      };
    },
  };

  const finish: Tool = {
    name: 'finish',
    description:
      'Declare the task complete. Calling this tool ends your turn — do not ' +
      'call it until the work is done and verified.',
    input_schema: finish_input,
    // D6: a successful `finish` ends the loop deterministically. The summary
    // is recorded in the trajectory like any tool call and otherwise ignored
    // — the workspace, not the self-report, is truth.
    ends_turn: true,
    execute: (raw) => {
      const input = finish_input.parse(raw);
      return `finished: ${input.summary}`;
    },
  };

  return [...read_only_tools(workspace), write_file, edit_file, bash, finish];
}
