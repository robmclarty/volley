/**
 * Critic prompt resolution and composition. Presets live as
 * markdown files in ./presets/ — discoverable by listing the directory —
 * and every critic system prompt gets the harness append.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config_error } from '../types.js';
import type {
  ChangeSet,
  ChangeStatus,
  ChangedFile,
  CheckResult,
  ResolvedConfig,
} from '../types.js';
import { state_path } from '../workspace.js';
import type { ToolSet } from '../workspace_tools.js';
import { build_root } from '../worktree.js';

/** Walk up from this module to the package root (works from src/ under tsx
 * and from dist/ in the published package, which ships src/critic/presets). */
export function presets_dir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'src', 'critic', 'presets');
    if (existsSync(candidate)) return candidate;
    const local = join(dir, 'presets');
    if (existsSync(local)) return local;
    dir = dirname(dir);
  }
  throw config_error('critic presets directory not found');
}

/** The harness append that names the critic's reads. The CLI critic reads
 * via built-in Read/Grep/Glob and never takes an injected set; every other
 * critic, local or `openrouter`, reads via volley's read_file/search_files/
 * list_files, or under `volley acp` via fascicle's read_file/list_files/
 * search. */
function harness_append_file(config: ResolvedConfig, tool_set: ToolSet): string {
  if (config.critic_provider === 'claude_cli') return 'harness_append.md';
  return tool_set === 'acp' ? 'harness_append_acp.md' : 'harness_append_local.md';
}

export function resolve_critic_prompt(config: ResolvedConfig, tool_set: ToolSet = 'volley'): string {
  const base =
    config.critic_prompt_path !== null
      ? readFileSync(config.critic_prompt_path, 'utf8')
      : readFileSync(join(presets_dir(), `${config.critic_preset}.md`), 'utf8');
  const append = readFileSync(join(presets_dir(), harness_append_file(config, tool_set)), 'utf8');
  return `${base.trimEnd()}\n\n${place_iterations_dir(append, config).trimEnd()}`;
}

const ITERATIONS_DIR = '{{iterations_dir}}';

/** Fill the harness append's line about prior iteration state with where the
 * run's `iterations/` sits, relative to the build root the critic reads from,
 * or drop the line when the run's state is outside that root: a confined
 * critic can't reach it, and naming it would only spend the critic's steps on
 * a path it can't open. */
function place_iterations_dir(append: string, config: ResolvedConfig): string {
  const path = relative(
    build_root(config.workspace, config.worktree),
    state_path(config, 'iterations'),
  );
  const outside = path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
  return append
    .split('\n')
    .filter((line) => !(outside && line.includes(ITERATIONS_DIR)))
    .join('\n')
    .replaceAll(ITERATIONS_DIR, `${path}/`);
}

export type CriticPromptInput = {
  criteria: string;
  iteration: number;
  check: CheckResult;
  /** What the builder changed since the run's baseline (`src/changes.ts`), or
   * null when the build root is not a git repository — then the section is
   * omitted rather than claiming the builder changed nothing. */
  changes: ChangeSet | null;
};

/** One-letter status column, so a hundred-path list stays readable. */
const STATUS_MARKS: Record<ChangeStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  unknown: '?',
};

function format_change(file: ChangedFile): string {
  return `  ${STATUS_MARKS[file.status]} ${file.path}`;
}

/**
 * What the builder actually touched, handed to the critic as evidence.
 *
 * Two things this fixes, both surfaced by the reckon run
 * (`research/reckon-local-run-finding.md`). A critic that sees only the finished
 * tree reviews *state* and re-reads code the check already blessed; a critic
 * that sees the change list reviews the *change*, and knows where to point its
 * read tools. And a builder that edited its own tests could previously pass both
 * gates in silence — the check because it was rewritten, the critic because
 * nothing told it that had happened.
 *
 * Paths only, never diff hunks: the list stays bounded for a 32k-context local
 * critic, which can read any file it wants once it knows which ones moved.
 */
function format_changes_section(changes: ChangeSet | null): string | null {
  if (changes === null) return null;
  const scope = changes.baseline === null ? 'this run' : `baseline ${changes.baseline.slice(0, 8)}`;
  if (changes.total === 0) {
    return [
      `BUILDER CHANGES (since ${scope})`,
      '------------------------------',
      'The builder changed no files. Unless the acceptance criteria were already',
      'met before this run, that is itself grounds for changes_requested.',
    ].join('\n');
  }
  const lines = [
    `BUILDER CHANGES (since ${scope})`,
    '------------------------------',
    'Review the work as a change, not just as a finished tree. Read the files',
    'below with your tools as needed.',
    '',
    ...changes.files.map(format_change),
  ];
  if (changes.truncated) {
    lines.push(
      `  … showing ${String(changes.files.length)} of ${String(changes.total)} changed paths`,
    );
  }
  if (changes.gate_edits.length > 0) {
    lines.push(
      '',
      `GATE EDITS (${String(changes.gate_edits.length)})`,
      '-----------',
      'These changed paths are part of the gate — the tests, fixtures, and check',
      'configuration that decide whether this work passes. A check the builder can',
      'edit proves less than one it cannot.',
      '',
      ...changes.gate_edits.map((path) => `  ! ${path}`),
      '',
      'Judge whether each of these edits was necessary and legitimate for the task',
      'as specified. If any of them weakened the check, deleted a case, or moved a',
      'target rather than meeting it, the work does not meet the criteria: return',
      'changes_requested, name the file, and say what was weakened.',
    );
  }
  return lines.join('\n');
}

function format_check_section(check: CheckResult): string {
  if (!check.ran) {
    return 'No deterministic check ran for this iteration. Base your verdict on workspace inspection alone.';
  }
  const lines = [
    `DETERMINISTIC CHECK (${check.runner})`,
    '------------------------------------',
    `result: ${check.ok ? 'PASSED' : 'FAILED'} (exit ${String(check.exit_code)})`,
  ];
  if (check.failing_slots.length > 0) {
    lines.push(`failing slots: ${check.failing_slots.join(', ')}`);
  }
  if (check.summary !== undefined) {
    lines.push('', 'summary.json:', '```json', JSON.stringify(check.summary, null, 2), '```');
  }
  for (const artifact of check.detail) {
    lines.push(
      '',
      `--- raw output for failing slot "${artifact.slot}"${artifact.truncated ? ` (truncated; full output archived at ${artifact.path ?? 'n/a'})` : ''} ---`,
      artifact.content,
    );
  }
  if (check.log !== undefined && check.log.length > 0) {
    lines.push('', 'check output:', '```', check.log, '```');
  }
  return lines.join('\n');
}

export function compose_critic_prompt(input: CriticPromptInput): string {
  const changes = format_changes_section(input.changes);
  return [
    'ACCEPTANCE CRITERIA',
    '-------------------',
    input.criteria,
    '',
    `ITERATION: ${input.iteration}`,
    '',
    format_check_section(input.check),
    ...(changes === null ? [] : ['', changes]),
    '',
    'Review the workspace against the acceptance criteria and return your',
    'structured verdict.',
  ].join('\n');
}
