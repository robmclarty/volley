/**
 * `--check` resolution: `auto` detects checkride in the workspace;
 * `none` disables the gate; anything else is a shell command — unless it is
 * recognizably checkride itself, which gets the structured runner.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckMode, CheckRunnerKind } from '../types.js';

function package_check_script_is_checkride(workspace: string): boolean {
  const path = join(workspace, 'package.json');
  if (!existsSync(path)) return false;
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const script = pkg.scripts?.['check'];
    return typeof script === 'string' && /(^|\s)checkride(\s|$)/.test(script);
  } catch {
    return false;
  }
}

export function checkride_detected(workspace: string): boolean {
  return (
    existsSync(join(workspace, 'checkride.config.json')) ||
    package_check_script_is_checkride(workspace) ||
    existsSync(join(workspace, 'node_modules', '.bin', 'checkride'))
  );
}

export function resolve_check_runner(
  check: CheckMode,
  workspace: string,
): CheckRunnerKind {
  if (check === 'none') return 'none';
  if (check === 'auto') {
    return checkride_detected(workspace) ? 'checkride' : 'none';
  }
  return /(^|\s)checkride(\s|$)/.test(check.trim()) ? 'checkride' : 'command';
}
