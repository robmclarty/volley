/**
 * Builder tool set for local (non-CLI) builders (v3 s1, D2).
 *
 * A local model brings no built-in tools, so volley supplies the whole
 * agentic surface: the shared read-only trio (reused from
 * `src/workspace_tools.ts`, C4) plus `write_file`, `edit_file`, and the
 * terminal `finish`. `bash` and `fetch` join in later steps. Every path is
 * confined to the workspace via `contain()`.
 *
 * Error semantics (D4/D10): a wrong-but-recoverable input — `edit_file`
 * matching 0 or N places — is *returned* as a tool result the model reads
 * and retries. Tools throw only on a genuine harness fault (containment
 * violation, unreadable input, over-cap write).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Tool } from 'fascicle';
import { contain, read_only_tools } from '../workspace_tools.js';

export const WRITE_FILE_MAX_BYTES = 1_000_000;

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

const finish_input = z.object({
  summary: z.string().describe('Short summary of what was accomplished.'),
});

function count_occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// Same wiring convention as the shared read tools: each tool is typed as
// fascicle's `Tool` (input `unknown`) and re-parses the model's raw
// arguments with its own schema inside `execute`.
export function builder_tools(workspace: string): Tool[] {
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

  return [...read_only_tools(workspace), write_file, edit_file, finish];
}
