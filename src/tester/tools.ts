/**
 * The tester's tools on any provider but `claude_cli`: the shared reads, and
 * `write_file` and `edit_file` held to the test and fixture gate paths.
 *
 * The tester writes a failing test from the criteria before the first build,
 * and its whole job is the test (move 1's D5). So a write must match a gate
 * pattern, and must not touch the gate's other half: `package.json`, a
 * `*.config.*` file, or anything under `.github/`. A tester that could rewrite
 * the check's configuration could make its own result red or green (D20). It
 * has no `bash` either, though the check runs what it writes, which is why a
 * tester on a local model is contained as a builder is (D14).
 *
 * A path that reaches through a symbolic link is refused too: `contain()` is
 * lexical, so `test/` linked to `src/` would otherwise let a write the
 * patterns allow land in the source.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Tool } from 'fascicle';
import { matches_any } from '../changes.js';
import { contain, read_only_tools, write_tools } from '../workspace_tools.js';

/** Why the tester may not write `rel` (a `/`-separated workspace path) though
 * a gate pattern matches it, or null when it may. */
function excluded_reason(rel: string): string | null {
  const segments = rel.split('/');
  const name = segments.at(-1) ?? '';
  if (name === 'package.json') return 'package.json decides which scripts and tests run';
  if (name.includes('.config.')) return 'a *.config.* file configures the check';
  if (segments.includes('.github')) return 'a path under .github/ is CI configuration';
  return null;
}

/** Whether a gate pattern can only ever name files the tester may not write:
 * `**\/package.json`, `**\/vitest.config.*`, `.github/workflows/**`. */
function names_only_excluded(pattern: string): boolean {
  return excluded_reason(pattern.replace(/\*+$/, 'x')) !== null;
}

/** The gate patterns the tester may write under: the gate's tests and
 * fixtures, its check configuration and manifest left out. Its prompt names
 * these, and a `claude_cli` tester's `Edit` rules are made from them. */
export function writable_gate_patterns(gate_paths: ReadonlyArray<string>): string[] {
  return gate_paths.filter((pattern) => !names_only_excluded(pattern));
}

/** Whether `path` exists as itself, a dangling link included. */
function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether `abs` (inside `root`) resolves somewhere other than where it reads:
 * its nearest existing ancestor's real path isn't that ancestor's place under
 * the root's real path, or can't be read (a dangling link). */
function resolves_elsewhere(root: string, abs: string): boolean {
  let probe = abs;
  while (!lexists(probe) && probe !== root) probe = dirname(probe);
  try {
    return realpathSync(probe) !== join(realpathSync(root), relative(root, probe));
  } catch {
    return true;
  }
}

/** Why the tester may not write `abs` (named `path` by the model) in
 * `workspace`, or null when it may. */
function tester_write_refusal(
  workspace: string,
  gate_paths: ReadonlyArray<string>,
  abs: string,
): string | null {
  const root = resolve(workspace);
  const rel = relative(root, abs).split(sep).join('/');
  if (rel === '' || !matches_any(rel, [...gate_paths])) {
    const writable = writable_gate_patterns(gate_paths);
    return writable.length === 0
      ? 'no gate pattern names a test or fixture path'
      : `it matches none of the test and fixture gate patterns (${writable.join(', ')})`;
  }
  const excluded = excluded_reason(rel);
  if (excluded !== null) return excluded;
  if (resolves_elsewhere(root, abs)) return 'it reaches through a symbolic link';
  return null;
}

/** The error a tester's write to `path` (named `path`, contained at `abs`)
 * is refused with, or null when it may write there. */
function refusal_message(
  workspace: string,
  gate_paths: ReadonlyArray<string>,
  abs: string,
  path: string,
): string | null {
  const refusal = tester_write_refusal(workspace, gate_paths, abs);
  return refusal === null
    ? null
    : `the tester can't write ${path}: ${refusal}. It writes tests and fixtures only.`;
}

/** Why the tester may not write `path` in `workspace`, as the message its
 * writers refuse with, or null when it may: for a tool set the tester takes
 * from elsewhere, as under `volley acp`, whose writers volley wraps. */
export function tester_refusal(
  workspace: string,
  gate_paths: ReadonlyArray<string>,
  path: string,
): string | null {
  let abs: string;
  try {
    abs = contain(workspace, path);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return refusal_message(workspace, gate_paths, abs, path);
}

/** The tester's tool set: the read trio, then `write_file` and `edit_file`
 * confined to the test and fixture gate paths. A refused write throws, naming
 * the path and why; fascicle feeds that back to the model. */
export function tester_tools(workspace: string, gate_paths: ReadonlyArray<string>): Tool[] {
  return [
    ...read_only_tools(workspace),
    ...write_tools(workspace, (abs, path) => {
      const refusal = refusal_message(workspace, gate_paths, abs, path);
      if (refusal !== null) throw new Error(refusal);
    }),
  ];
}
