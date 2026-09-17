/**
 * checkride runner: spawn `pnpm exec checkride --json`, gate on the
 * `.check/summary.json` contract (`schema_version: 1`), and collect raw
 * failing-slot artifacts for the critic — the critic reads what the tool
 * actually said, not a normalized digest.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { aborted_error } from 'fascicle';
import { check_error } from '../types.js';
import type { CheckArtifact, CheckResult } from '../types.js';

export const CHECK_ARTIFACT_MAX_CHARS = 8000;

export const CHECKRIDE_SCHEMA_VERSION = 1;

export type CheckrideSummaryCheck = {
  name: string;
  adapter: string | null;
  ok: boolean;
  skipped?: boolean;
  exit_code: number | null;
  duration_ms: number;
  output_file: string | null;
};

export type CheckrideSummary = {
  schema_version: number;
  ok: boolean;
  total_duration_ms: number;
  checks: CheckrideSummaryCheck[];
};

export type SpawnCaptureResult = {
  exit_code: number | null;
  stdout: string;
  stderr: string;
};

export function spawn_capture(
  cmd: string,
  args: string[],
  options: { cwd: string; abort?: AbortSignal },
): Promise<SpawnCaptureResult> {
  return new Promise((resolve_promise, reject) => {
    const proc = spawn(cmd, args, {
      cwd: options.cwd,
      ...(options.abort !== undefined ? { signal: options.abort } : {}),
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => {
      if (err.name === 'AbortError') {
        reject(new aborted_error('check aborted'));
        return;
      }
      reject(check_error(`check command failed to start: ${err.message}`));
    });
    proc.on('close', (code) => {
      resolve_promise({ exit_code: code, stdout, stderr });
    });
  });
}

export type ParsedSummary = {
  summary: CheckrideSummary;
  warning: string | null;
};

/** Best-effort parse of the summary contract. `pnpm exec` talks over the
 * command's stdout (pnpm 11's dep-verify prints an "Already up to date"
 * install line ahead of the JSON), so the object is extracted between the
 * first `{` and the last `}` rather than parsed from byte 0. An unexpected
 * schema_version warns and still parses; no JSON object at all is a harness
 * error (exit 4). */
export function parse_checkride_summary(stdout: string): ParsedSummary {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  let raw: unknown;
  try {
    if (start === -1 || end < start) throw new Error('no JSON object in stdout');
    raw = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    throw check_error('checkride --json produced unparseable stdout');
  }
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as CheckrideSummary).checks)) {
    throw check_error('checkride summary missing checks array');
  }
  const summary = raw as CheckrideSummary;
  const warning =
    summary.schema_version === CHECKRIDE_SCHEMA_VERSION
      ? null
      : `checkride summary schema_version ${String(summary.schema_version)} != ${String(CHECKRIDE_SCHEMA_VERSION)}; parsing best-effort`;
  return { summary, warning };
}

/** Parse the summary from stdout, falling back to the on-disk contract:
 * `.check/summary.json` is what checkride documents; stdout is its mirror and
 * wrappers may talk over it beyond what the tolerant slice can recover. */
export function parse_summary_with_fallback(stdout: string, workspace: string): ParsedSummary {
  try {
    return parse_checkride_summary(stdout);
  } catch (err) {
    const file = join(workspace, '.check', 'summary.json');
    if (!existsSync(file)) throw err;
    return parse_checkride_summary(readFileSync(file, 'utf8'));
  }
}

export function failing_checks(summary: CheckrideSummary): CheckrideSummaryCheck[] {
  return summary.checks.filter((c) => !c.ok && c.skipped !== true);
}

/** Per failing slot: the raw artifact (`.check/<output_file>` when present,
 * else `.check/<slot>.stdout.txt`), truncated with a pointer to the file. */
export function read_failing_artifacts(
  workspace: string,
  failing: CheckrideSummaryCheck[],
): CheckArtifact[] {
  return failing.map((check) => {
    const file = check.output_file ?? `${check.name}.stdout.txt`;
    const path = join(workspace, '.check', file);
    if (!existsSync(path)) {
      return { slot: check.name, path: null, content: '(no artifact found)', truncated: false };
    }
    const raw = readFileSync(path, 'utf8');
    const truncated = raw.length > CHECK_ARTIFACT_MAX_CHARS;
    return {
      slot: check.name,
      path,
      content: truncated ? raw.slice(0, CHECK_ARTIFACT_MAX_CHARS) : raw,
      truncated,
    };
  });
}

export type CheckrideOpts = {
  workspace: string;
  abort?: AbortSignal;
};

export async function run_checkride(opts: CheckrideOpts): Promise<CheckResult> {
  const proc = await spawn_capture('pnpm', ['exec', 'checkride', '--json'], {
    cwd: opts.workspace,
    ...(opts.abort !== undefined ? { abort: opts.abort } : {}),
  });
  // checkride exit 2 is a harness/usage error — an operator problem, not
  // something to iterate on.
  if (proc.exit_code === 2) {
    throw check_error(`checkride harness error: ${proc.stderr.trim()}`);
  }
  const { summary } = parse_summary_with_fallback(proc.stdout, opts.workspace);
  const failing = failing_checks(summary);
  return {
    ran: true,
    runner: 'checkride',
    ok: summary.ok,
    exit_code: proc.exit_code,
    duration_ms: summary.total_duration_ms,
    failing_slots: failing.map((c) => c.name),
    detail: read_failing_artifacts(opts.workspace, failing),
    summary,
  };
}
