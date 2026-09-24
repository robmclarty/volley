/**
 * Display formatting: glyph taxonomy, role colors, truncation.
 * All human output goes to stderr; these helpers only build strings.
 */
import pc from 'picocolors';

export const GLYPH_TOOL = '🔧';
export const GLYPH_OK = '✅';
export const GLYPH_ERR = '❌';
export const GLYPH_COST = '💰';
export const GLYPH_PHASE_START = '▶';
export const GLYPH_PHASE_OK = '✓';
export const GLYPH_PHASE_FAIL = '✗';

export const VERBOSE_TRUNCATE_CHARS = 4000;

export type Role = 'builder' | 'critic' | 'check';

export function colors_enabled(
  env: Record<string, string | undefined> = process.env,
  is_tty: boolean = process.stderr.isTTY === true,
): boolean {
  if (env['NO_COLOR'] !== undefined || env['VOLLEY_NO_COLOR'] !== undefined) {
    return false;
  }
  return is_tty;
}

export function paint(role: Role | 'cost' | 'error', text: string, color: boolean): string {
  if (!color) return text;
  switch (role) {
    case 'builder':
      return pc.cyan(text);
    case 'critic':
      return pc.yellow(text);
    case 'check':
      return pc.green(text);
    case 'cost':
      return pc.magenta(text);
    case 'error':
      return pc.bold(pc.red(text));
  }
}

export function dim(text: string, color: boolean): string {
  return color ? pc.dim(text) : text;
}

export function truncate(text: string, max: number, pointer: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated at ${String(max)} chars; ${pointer}]`;
}

export function format_usd(value: number | null): string {
  return value === null ? '$?' : `$${value.toFixed(3)}`;
}

/** One-line summary of a tool input for the default streaming mode. */
export function summarize_value(value: unknown, max = 120): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  } catch {
    text = String(value);
  }
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
