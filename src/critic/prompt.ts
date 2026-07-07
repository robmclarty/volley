/**
 * Critic prompt resolution and composition (spec §6). Presets live as
 * markdown files in ./presets/ — discoverable by listing the directory —
 * and every critic system prompt gets the harness append.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config_error } from '../types.js';
import type { CheckResult, ResolvedConfig } from '../types.js';

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

export function resolve_critic_prompt(config: ResolvedConfig): string {
  const base =
    config.critic_prompt_path !== null
      ? readFileSync(config.critic_prompt_path, 'utf8')
      : readFileSync(join(presets_dir(), `${config.critic_preset}.md`), 'utf8');
  // The CLI critic reads via built-in Read/Grep/Glob; a local-model critic
  // reads via volley's supplied read_file/search_files/list_files tools, so
  // its harness instructions name a different tool set.
  const append_file =
    config.critic_provider === 'claude_cli' ? 'harness_append.md' : 'harness_append_local.md';
  const append = readFileSync(join(presets_dir(), append_file), 'utf8');
  return `${base.trimEnd()}\n\n${append.trimEnd()}`;
}

export type CriticPromptInput = {
  criteria: string;
  iteration: number;
  check: CheckResult;
};

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
  return [
    'ACCEPTANCE CRITERIA',
    '-------------------',
    input.criteria,
    '',
    `ITERATION: ${input.iteration}`,
    '',
    format_check_section(input.check),
    '',
    'Review the workspace against the acceptance criteria and return your',
    'structured verdict.',
  ].join('\n');
}
