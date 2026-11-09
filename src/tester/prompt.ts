/**
 * The tester's prompts: its system prompt, the `tester.md` preset and a line
 * naming the tools its seat holds, and the prompt of its one call, composed
 * from the criteria, where it may write, the check that will run its test, and
 * the workspace inventory.
 *
 * The tester writes from the criteria rather than the task (move 1's Frame): a
 * critic can be argued with about prose criteria, a test can't, so the test
 * is the criteria made executable. The inventory saves its first turns on
 * finding where the tests live.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config_error } from '../types.js';
import type { CriticProvider } from '../types.js';

/** Walk up from this module to the package root (works from src/ under tsx
 * and from dist/ in the published package, which ships src/tester/presets). */
export function tester_presets_dir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'src', 'tester', 'presets');
    if (existsSync(candidate)) return candidate;
    const local = join(dir, 'presets');
    if (existsSync(join(local, 'tester.md'))) return local;
    dir = dirname(dir);
  }
  throw config_error('tester presets directory not found');
}

/** The tools a tester on `provider` holds, as its system prompt names them:
 * the Claude CLI's own, under the tester's permission list, or volley's. */
function tools_paragraph(provider: CriticProvider): string {
  if (provider === 'claude_cli') {
    return [
      'Read the workspace with Read, Grep and Glob. Write and Edit work only on the',
      'paths your prompt lists as writable, and are refused anywhere else. You',
      'cannot run commands.',
    ].join('\n');
  }
  return [
    'You have five tools, every path workspace-relative:',
    '- read_file(path), search_files(pattern, path?, ignore_case?) and',
    '  list_files(path?, contains?) read the workspace.',
    '- write_file(path, content) and edit_file(path, old_str, new_str) write',
    '  only the paths your prompt lists as writable; anywhere else they refuse,',
    '  naming why.',
    'You cannot run commands; no other tools are available to you.',
  ].join('\n');
}

/** The tester's system prompt for a seat on `provider`. */
export function resolve_tester_prompt(provider: CriticProvider): string {
  const base = readFileSync(join(tester_presets_dir(), 'tester.md'), 'utf8');
  return `${base.trimEnd()}\n\n${tools_paragraph(provider)}`;
}

export type TesterPromptInput = {
  criteria: string;
  /** The gate patterns the tester may write under (`writable_gate_patterns`). */
  writable: ReadonlyArray<string>;
  /** The check that runs after the tester, as configured (`auto`, a command). */
  check: string;
  /** The build root's paths and sizes (`workspace_inventory`). */
  inventory: string;
};

export function compose_tester_prompt(input: TesterPromptInput): string {
  const check = input.check === 'auto' ? 'checkride, found by --check auto' : `\`${input.check}\``;
  return [
    'ACCEPTANCE CRITERIA',
    '-------------------',
    input.criteria,
    '',
    'WHERE YOU MAY WRITE',
    '-------------------',
    'Paths matching these patterns, except package.json, *.config.* files and',
    'anything under .github/:',
    ...input.writable.map((pattern) => `  ${pattern}`),
    '',
    'THE CHECK',
    '---------',
    `${check} runs once you finish. It must fail then, on your test.`,
    '',
    'WORKSPACE FILE INVENTORY',
    '------------------------',
    input.inventory,
    '',
    'Write the failing test now.',
  ].join('\n');
}
