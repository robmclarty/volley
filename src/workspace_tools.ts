/**
 * Shared workspace tools: `contain()` path confinement, the read-only tool set
 * (`read_file`, `search_files`, `list_files`), and the two file writers
 * (`write_file`, `edit_file`).
 *
 * The claude_cli builder/critic get file access from the CLI's own built-in
 * tools. API-style providers (ollama, lmstudio, …) have no built-ins, so
 * volley supplies its own. The critic uses the read-only set as-is via
 * `src/critic/tools.ts`; the builder set in `src/builder/tools.ts` adds the
 * writers and its exec surface; the tester's (`src/tester/tools.ts`) adds the
 * writers held to the test and fixture paths, which is why they live here
 * rather than in the builder's module. Every path is resolved and confined to
 * the workspace root.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Tool } from 'fascicle';

export const READ_FILE_MAX_BYTES = 200_000;
export const WRITE_FILE_MAX_BYTES = 1_000_000;
export const SEARCH_MAX_MATCHES = 200;
const LIST_MAX_ENTRIES = 2000;

/** Directories never worth handing a seat; they bury signal and blow the
 * traversal budget. The acp seats' `list_files` and `search` skip the same
 * names (`./acp_tools.ts`), so a seat sees one tree under acp and on the CLI. */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.volley',
  '.check',
  'dist',
  '.cache',
]);

/** Which tool set a seat holds, so its prompt names the tools it has: volley's
 * own (`'volley'`), or fascicle's workspace tools under `volley acp`
 * (`'acp'`). */
export type ToolSet = 'volley' | 'acp';

/** Resolve `rel` inside `workspace`, rejecting absolute paths and any `..`
 * escape. Returns the absolute path; throws on containment violation. The
 * `workspace` root passed here is the build root, which is the per-run git
 * worktree under `--worktree` (`build_root`), not necessarily the
 * workspace the run was started on. */
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

/** The files a read tool's optional `path` covers: the whole tree, the tree
 * under a directory, or the one file it names. A path that doesn't exist
 * throws, so the seat reads why rather than an empty result that looks like
 * "nothing matched". */
function scoped_files(workspace: string, path: string | undefined, limit: number): WalkEntry[] {
  const root = resolve(workspace);
  if (path === undefined) return walk(root, root, limit);
  const start = contain(workspace, path);
  let is_dir: boolean;
  try {
    is_dir = statSync(start).isDirectory();
  } catch (err) {
    throw new Error(`no such file or directory: ${path}`, { cause: err });
  }
  return is_dir ? walk(root, start, limit) : [{ rel: relative(root, start), abs: start }];
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
    .describe('Optional workspace-relative directory or file to limit the search to.'),
  ignore_case: z.boolean().optional().describe('Case-insensitive match. Default false.'),
});

const list_files_input = z.object({
  path: z
    .string()
    .optional()
    .describe('Optional workspace-relative directory or file. Default: the workspace root.'),
  contains: z
    .string()
    .optional()
    .describe('Optional substring filter applied to each relative path.'),
});

// Each is `read_only`, so a builder's per-turn call cap doesn't count it: a
// read changes nothing a later call in the turn could depend on.
//
// Each tool is typed as fascicle's `Tool` (input `unknown`) and re-parses the
// model's raw arguments with its own schema. fascicle's `Tool` is invariant
// on the input type, so typed-per-tool values will not widen into `Tool[]`;
// parsing inside `execute` keeps the wiring cast-free and validates arguments
// at the boundary. The declared `input_schema` still drives the JSON schema
// the model sees.
export function read_only_tools(workspace: string): Tool[] {
  const read_file: Tool = {
    name: 'read_file',
    read_only: true,
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
    read_only: true,
    description:
      'Search workspace files for lines matching a regular expression. Returns ' +
      `up to ${String(SEARCH_MAX_MATCHES)} "relative/path:line: text" hits.`,
    input_schema: search_files_input,
    execute: (raw) => {
      const input = search_files_input.parse(raw);
      const regex = build_regex(input.pattern, input.ignore_case === true ? 'i' : '');
      const files = scoped_files(workspace, input.path, LIST_MAX_ENTRIES);
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
    read_only: true,
    description:
      'List files under a workspace directory (recursively; skips node_modules, ' +
      '.git, and other build/output directories).',
    input_schema: list_files_input,
    execute: (raw) => {
      const input = list_files_input.parse(raw);
      let files = scoped_files(workspace, input.path, LIST_MAX_ENTRIES).map((f) => f.rel);
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

function count_occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** A writer's guard: given the contained absolute path and the path as the
 * model named it, it throws to refuse the write, naming why. */
export type WriteGuard = (abs: string, path: string) => void;

/** `write_file` and `edit_file`, confined to the workspace, and to whatever
 * `guard` allows besides. A wrong-but-recoverable edit (0 or N matches) is
 * returned for the model to read; a refused path or an over-cap write throws,
 * as a containment violation does. */
export function write_tools(workspace: string, guard?: WriteGuard): Tool[] {
  const target = (path: string): string => {
    const abs = contain(workspace, path);
    guard?.(abs, path);
    return abs;
  };

  const write_file: Tool = {
    name: 'write_file',
    description:
      'Write a UTF-8 text file in the workspace, creating parent directories ' +
      'and overwriting any existing content. Rejects content over ' +
      `${String(WRITE_FILE_MAX_BYTES)} bytes.`,
    input_schema: write_file_input,
    execute: (raw) => {
      const input = write_file_input.parse(raw);
      const abs = target(input.path);
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
      const abs = target(input.path);
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

  return [write_file, edit_file];
}

/** A `paths + sizes` listing of the workspace tree, no file contents — the
 * grounding a tool-less critic gets when its provider's tool parser died and the
 * degradation ladder traded read access for survival. Reuses the same
 * `walk` + `IGNORED_DIRS` traversal as the read tools, so the inventory matches
 * what a working `list_files` would have surfaced; caps at `limit` entries. */
export function workspace_inventory(root: string, limit: number = LIST_MAX_ENTRIES): string {
  const base = resolve(root);
  const files = walk(base, base, limit);
  if (files.length === 0) return 'no files';
  const lines = files.map((file) => {
    let size: number;
    try {
      size = statSync(file.abs).size;
    } catch {
      size = 0;
    }
    return `${file.rel} (${String(size)} bytes)`;
  });
  const capped =
    files.length >= limit ? `\n… [capped at ${String(limit)} entries]` : '';
  return `${lines.join('\n')}${capped}`;
}
