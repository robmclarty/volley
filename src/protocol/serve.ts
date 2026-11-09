/**
 * `volley run --protocol runciter.run/1`: one run as runciter's run child (its
 * spec §5.4), so runciter's `process` kind runs volley with no adapter of its
 * own (move 1's Frame). One `RunInput` comes in on stdin; exactly one
 * `RunOutput` goes out on stdout, and nothing else does (C5); progress and
 * usage go to stderr as runciter's typed lines, beside the run's human lines.
 *
 * The exit code is the protocol's (D11). A run that ends, however it ends, a
 * builder, check or critic error included, exits 0 with a `RunOutput` that says
 * so, which keeps the summary and `data` in runciter's drawer (D28). Bad input,
 * a refused flag (D13) or a config error exits 2, and a failure that leaves no
 * `RunOutput` to write exits 1; either way the last stderr line is a
 * `StdioFailure`, the shape fascicle's `run_stdio` gives it, which runciter
 * takes as the failure's detail.
 *
 * The run's state goes under `<run_dir>/volley/`, outside the workspace
 * runciter diffs and verifies, and the critic's last feedback is copied to
 * `<run_dir>/artifacts/critic-feedback.md` (D26). Neither copy follows a link:
 * the builder and the check can reach the run directory, and a `feedback.md`
 * linked to a credentials file would otherwise put its bytes in the artifacts,
 * as runciter's `volley` kind guarded against.
 */
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import type { StdioFailure } from 'fascicle/stdio';
import { resolve_config } from '../config.js';
import {
  EXIT_CONFIG_ERROR,
  exit_code_for_error,
  PROTOCOL_EXIT_CONTRACT_VIOLATION,
  PROTOCOL_EXIT_OUTPUT,
  PROTOCOL_EXIT_RUNNER_ERROR,
} from '../exit_codes.js';
import { run_volley } from '../orchestrator.js';
import type { OrchestratorDeps } from '../orchestrator.js';
import { build_run_summary } from '../summary.js';
import type { RunSummary } from '../summary.js';
import type { ResolvedConfig } from '../types.js';
import { state_path } from '../workspace.js';
import {
  CRITIC_FEEDBACK_ARTIFACT,
  input_to_config,
  result_to_output,
  run_input_schema,
  run_output_schema,
} from './runciter_run.js';
import type { ProtocolFlags, RunArtifact, RunciterRunInput } from './runciter_run.js';

type Renderer = OrchestratorDeps['renderer'];

/** What protocol mode reads and writes: stdin to its end, stdout, which takes
 * the one `RunOutput` and resolves once it's flushed, and stderr. */
export type ProtocolIo = {
  read_input: () => Promise<string>;
  write_output: (chunk: string) => Promise<void>;
  write_error: (chunk: string) => void;
};

/** What the agent's argv gave: its settings, read only once protocol mode can
 * report a failure to read them, and the words it gave besides its flags. */
export type ProtocolArgv = {
  read_flags: () => Promise<ProtocolFlags>;
  positionals: readonly string[];
};

export type ProtocolDeps = Omit<OrchestratorDeps, 'renderer'> & {
  /** The renderer for the resolved run, in protocol mode. */
  renderer_for: (config: ResolvedConfig) => Renderer;
  /** What a run says once its config resolves, before it spends. */
  before_run?: (config: ResolvedConfig, renderer: Renderer) => void;
  /** The environment the config resolves against (default: volley's own). */
  env?: Record<string, string | undefined>;
};

/** What protocol mode refuses from the argv (D13), with why: runciter owns the
 * workspace and its commits, and stdout carries the `RunOutput`. */
const REFUSED: ReadonlyArray<readonly [keyof ProtocolFlags, string, string]> = [
  ['worktree', '--worktree', 'runciter owns the workspace'],
  ['git_checkpoints', '--git', "runciter owns the workspace and what's committed to it"],
  ['json', '--json', 'stdout carries the RunOutput'],
];

function refusal(flags: ProtocolFlags, positionals: readonly string[]): string | null {
  if (positionals.length > 0) {
    return `protocol mode refuses a positional prompt (${positionals.join(' ')}): the RunInput gives the prompt`;
  }
  for (const [field, flag, why] of REFUSED) {
    if (flags[field] === true) return `protocol mode refuses ${flag} (${field}): ${why}`;
  }
  return null;
}

function message_of(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A value as JSON can carry it, or nothing when it can't. */
function json_safe(value: unknown): unknown {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : (JSON.parse(json) as unknown);
  } catch {
    return undefined;
  }
}

/** An exit with no `RunOutput`: the failure as the last stderr line. */
type Failed = { code: number; failure: StdioFailure };

/** A thrown config error is the input's or the argv's fault, so a contract
 * violation; anything else left volley with nothing to report. */
function failed_on(err: unknown, stage?: StdioFailure['stage']): Failed {
  const code =
    exit_code_for_error(err) === EXIT_CONFIG_ERROR
      ? PROTOCOL_EXIT_CONTRACT_VIOLATION
      : PROTOCOL_EXIT_RUNNER_ERROR;
  return { code, failure: { error: message_of(err), ...(stage !== undefined ? { stage } : {}) } };
}

function contract_violation(failure: StdioFailure): Failed {
  return { code: PROTOCOL_EXIT_CONTRACT_VIOLATION, failure };
}

/** The `RunInput` on stdin, or why it isn't one. */
async function read_run_input(io: ProtocolIo): Promise<{ input: RunciterRunInput } | Failed> {
  let raw: string;
  try {
    raw = await io.read_input();
  } catch (err) {
    return contract_violation({ error: `stdin can't be read: ${message_of(err)}`, stage: 'read' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return contract_violation({ error: `stdin isn't JSON: ${message_of(err)}`, stage: 'parse' });
  }
  const checked = run_input_schema.safeParse(parsed);
  if (!checked.success) {
    const issues = checked.error.issues
      .map((issue) => (issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ${issue.message}` : issue.message))
      .join('; ');
    return contract_violation({
      error: `stdin isn't a runciter.run/1 RunInput: ${issues}`,
      stage: 'validate_input',
      cause: json_safe(checked.error.issues),
    });
  }
  return { input: checked.data };
}

/** `O_NOFOLLOW`, where the platform has one. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** A regular file's text, never through a link at its own path; null when
 * there's no file there. */
function read_unfollowed(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} isn't a regular file`);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function write_unfollowed(path: string, content: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, 0o644);
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

/** The critic's last feedback, copied to the run directory's artifacts (D26):
 * its text for the summary, and the artifact when the copy landed. A copy
 * that fails costs the artifact, not the run's output. */
function keep_feedback(
  config: ResolvedConfig,
  input: RunciterRunInput,
  renderer: Renderer,
): { feedback: string | null; artifacts: RunArtifact[] } {
  let feedback: string | null;
  try {
    feedback = read_unfollowed(state_path(config, 'feedback.md'));
  } catch (err) {
    renderer.warn(`the critic's feedback.md isn't read, so no feedback is reported: ${message_of(err)}`);
    return { feedback: null, artifacts: [] };
  }
  if (feedback === null) return { feedback: null, artifacts: [] };
  const artifacts = join(input.run_dir, 'artifacts');
  try {
    mkdirSync(artifacts, { recursive: true });
    write_unfollowed(join(artifacts, CRITIC_FEEDBACK_ARTIFACT.path), feedback);
    return { feedback, artifacts: [CRITIC_FEEDBACK_ARTIFACT] };
  } catch (err) {
    renderer.warn(`the critic's feedback couldn't be copied to ${artifacts}, so it isn't listed: ${message_of(err)}`);
    return { feedback, artifacts: [] };
  }
}

/** The summary a run that threw left behind: `summary.json`, which the
 * orchestrator stamps with the run's last status before it rethrows. */
function summary_left(config: ResolvedConfig): RunSummary | null {
  try {
    const summary = JSON.parse(readFileSync(state_path(config, 'summary.json'), 'utf8')) as RunSummary;
    return typeof summary.status === 'string' ? summary : null;
  } catch {
    return null;
  }
}

/** The run, to its summary: the result's, or the one an error left behind,
 * with the error. */
async function run(
  config: ResolvedConfig,
  renderer: Renderer,
  deps: ProtocolDeps,
): Promise<{ summary: RunSummary; error?: unknown } | Failed> {
  const { renderer_for: _renderer_for, before_run: _before_run, env: _env, ...orchestrator } = deps;
  try {
    const result = await run_volley(config, { ...orchestrator, renderer });
    return { summary: build_run_summary(config, result) };
  } catch (err) {
    if (exit_code_for_error(err) === EXIT_CONFIG_ERROR) return failed_on(err, 'run');
    renderer.error(message_of(err));
    const summary = summary_left(config);
    return summary === null ? failed_on(err, 'run') : { summary, error: err };
  }
}

/** One run under runciter's protocol, to its exit code. */
async function serve(argv: ProtocolArgv, io: ProtocolIo, deps: ProtocolDeps): Promise<number | Failed> {
  let flags: ProtocolFlags;
  try {
    flags = await argv.read_flags();
  } catch (err) {
    return failed_on(err);
  }
  const refused = refusal(flags, argv.positionals);
  if (refused !== null) return contract_violation({ error: refused });

  const read = await read_run_input(io);
  if ('failure' in read) return read;

  let config: ResolvedConfig;
  try {
    const mapped = input_to_config(read.input, flags);
    config = resolve_config(mapped.config, {
      run_id: mapped.run_id,
      ...(deps.env !== undefined ? { env: deps.env } : {}),
    });
  } catch (err) {
    return failed_on(err, 'validate_input');
  }
  const renderer = deps.renderer_for(config);
  deps.before_run?.(config, renderer);

  const ran = await run(config, renderer, deps);
  if ('failure' in ran) return ran;
  const kept = keep_feedback(config, read.input, renderer);
  renderer.final_summary(ran.summary);

  const checked = run_output_schema.safeParse(
    result_to_output(ran.summary, { ...kept, ...('error' in ran ? { error: ran.error } : {}) }),
  );
  if (!checked.success) {
    return contract_violation({
      error: "volley's RunOutput failed its own schema",
      stage: 'validate_output',
      cause: json_safe(checked.error.issues),
    });
  }
  try {
    await io.write_output(`${JSON.stringify(checked.data)}\n`);
  } catch (err) {
    return { code: PROTOCOL_EXIT_RUNNER_ERROR, failure: { error: message_of(err), stage: 'write' } };
  }
  return PROTOCOL_EXIT_OUTPUT;
}

/**
 * `volley run --protocol runciter.run/1` over `io`: reads the argv and one
 * `RunInput`, runs, and writes one `RunOutput`, to the protocol's exit code.
 * Every exit but 0 ends stderr on its `StdioFailure`.
 */
export async function serve_protocol(argv: ProtocolArgv, io: ProtocolIo, deps: ProtocolDeps): Promise<number> {
  const outcome = await serve(argv, io, deps);
  if (typeof outcome === 'number') return outcome;
  io.write_error(`${JSON.stringify(outcome.failure)}\n`);
  return outcome.code;
}

function write_flushed(stream: NodeJS.WriteStream, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** The process's own streams, with the console's stdout methods sent to
 * stderr for the rest of the process, so a stray log can't land beside the
 * `RunOutput` (C5), as fascicle's `run_stdio` does. */
export function process_io(): ProtocolIo {
  const to_stderr = (...args: unknown[]): void => {
    console.error(...args);
  };
  console.log = to_stderr;
  console.info = to_stderr;
  console.debug = to_stderr;
  return {
    read_input: () => text(process.stdin),
    write_output: (chunk) => write_flushed(process.stdout, chunk),
    write_error: (chunk) => {
      process.stderr.write(chunk);
    },
  };
}
