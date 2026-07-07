/**
 * Read-only workspace tools for non-CLI critics (spec §13 Q3).
 *
 * The claude_cli critic gets its Read/Grep/Glob from the CLI's own built-in
 * tools. API-style providers (ollama, lmstudio, …) have no built-ins, so
 * volley supplies its own read-only set: `read_file`, `search_files`,
 * `list_files`. Every path is resolved and confined to the workspace root —
 * a non-CLI critic still has no write path and cannot escape the workspace.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Tool } from 'fascicle';

export const READ_FILE_MAX_BYTES = 200_000;
export const SEARCH_MAX_MATCHES = 200;
export const LIST_MAX_ENTRIES = 2000;

/** Directories never worth handing a critic; they bury signal and blow the
 * traversal budget. */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.volley',
  '.check',
  'dist',
  '.cache',
]);

/** Resolve `rel` inside `workspace`, rejecting absolute paths and any `..`
 * escape. Returns the absolute path; throws on containment violation. */
export function contain(workspace: string, rel: string): string {
  const root = resolve(workspace);
  const candidate = isAbsolute(rel) ? resolve(rel) : resolve(root, rel);
  const within = candidate === root || candidate.startsWith(`${root}${sep}`);
  if (!within) {
    throw new Error(`path escapes the workspace: ${rel}`);
  }
  return candidate;
}

type WalkEntry = { rel: string; abs: string };

function walk(root: string, start: string, limit: number): WalkEntry[] {
  const out: WalkEntry[] = [];
  const stack = [start];
  while (stack.length > 0 && out.length < limit) {
    const dir = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      let is_dir: boolean;
      try {
        is_dir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (is_dir) {
        if (!IGNORED_DIRS.has(name)) stack.push(abs);
        continue;
      }
      out.push({ rel: relative(root, abs), abs });
      if (out.length >= limit) break;
    }
  }
  return out;
}

function build_regex(pattern: string, flags: string): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid regular expression: ${detail}`);
  }
}

const read_file_input = z.object({
  path: z.string().describe('Workspace-relative path to the file to read.'),
});

const search_files_input = z.object({
  pattern: z.string().describe('JavaScript regular expression to match against each line.'),
  path: z
    .string()
    .optional()
    .describe('Optional workspace-relative subdirectory to limit the search to.'),
  ignore_case: z.boolean().optional().describe('Case-insensitive match. Default false.'),
});

const list_files_input = z.object({
  path: z
    .string()
    .optional()
    .describe('Optional workspace-relative subdirectory. Default: the workspace root.'),
  contains: z
    .string()
    .optional()
    .describe('Optional substring filter applied to each relative path.'),
});

// Each tool is typed as fascicle's `Tool` (input `unknown`) and re-parses the
// model's raw arguments with its own schema. fascicle's `Tool` is invariant
// on the input type, so typed-per-tool values will not widen into `Tool[]`;
// parsing inside `execute` keeps the wiring cast-free and validates arguments
// at the boundary. The declared `input_schema` still drives the JSON schema
// the model sees.
export function read_only_tools(workspace: string): Tool[] {
  const read_file: Tool = {
    name: 'read_file',
    description:
      'Read a UTF-8 text file from the workspace. Returns the file content ' +
      `(truncated at ${String(READ_FILE_MAX_BYTES)} bytes).`,
    input_schema: read_file_input,
    execute: (raw) => {
      const input = read_file_input.parse(raw);
      const abs = contain(workspace, input.path);
      const content = readFileSync(abs, 'utf8');
      return content.length > READ_FILE_MAX_BYTES
        ? `${content.slice(0, READ_FILE_MAX_BYTES)}\n… [truncated at ${String(READ_FILE_MAX_BYTES)} bytes]`
        : content;
    },
  };

  const search_files: Tool = {
    name: 'search_files',
    description:
      'Search workspace files for lines matching a regular expression. Returns ' +
      `up to ${String(SEARCH_MAX_MATCHES)} "relative/path:line: text" hits.`,
    input_schema: search_files_input,
    execute: (raw) => {
      const input = search_files_input.parse(raw);
      const start = input.path !== undefined ? contain(workspace, input.path) : resolve(workspace);
      const regex = build_regex(input.pattern, input.ignore_case === true ? 'i' : '');
      const files = walk(resolve(workspace), start, LIST_MAX_ENTRIES);
      const hits: string[] = [];
      for (const file of files) {
        if (hits.length >= SEARCH_MAX_MATCHES) break;
        let content: string;
        try {
          content = readFileSync(file.abs, 'utf8');
        } catch {
          continue;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          if (hits.length >= SEARCH_MAX_MATCHES) break;
          const line = lines[i] as string;
          if (regex.test(line)) hits.push(`${file.rel}:${String(i + 1)}: ${line.trim()}`);
        }
      }
      if (hits.length === 0) return 'no matches';
      const capped =
        hits.length >= SEARCH_MAX_MATCHES ? `\n… [capped at ${String(SEARCH_MAX_MATCHES)} matches]` : '';
      return `${hits.join('\n')}${capped}`;
    },
  };

  const list_files: Tool = {
    name: 'list_files',
    description:
      'List files under a workspace directory (recursively; skips node_modules, ' +
      '.git, and other build/output directories).',
    input_schema: list_files_input,
    execute: (raw) => {
      const input = list_files_input.parse(raw);
      const start = input.path !== undefined ? contain(workspace, input.path) : resolve(workspace);
      let files = walk(resolve(workspace), start, LIST_MAX_ENTRIES).map((f) => f.rel);
      if (input.contains !== undefined) {
        const needle = input.contains;
        files = files.filter((f) => f.includes(needle));
      }
      if (files.length === 0) return 'no files';
      const capped =
        files.length >= LIST_MAX_ENTRIES ? `\n… [capped at ${String(LIST_MAX_ENTRIES)} entries]` : '';
      return `${files.join('\n')}${capped}`;
    },
  };

  return [read_file, search_files, list_files];
}
