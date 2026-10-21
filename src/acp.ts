/**
 * `volley acp`: volley served to an editor over the Agent Client Protocol,
 * through fascicle's `serve_acp`. Each prompt in the editor's agent panel is
 * a fresh volley run, in place, on the folder the editor has open.
 *
 *   serve_acp
 *   └─ per session/new: acp_turn        one step, whose id no model call shares
 *      └─ per prompt: run_volley        on session.cwd, its state under the state root
 *         ├─ builder                    fascicle's workspace tools + finish, asking through session.approve
 *         ├─ critic                     that set's three reads
 *         └─ trajectory                 the turn's own logger, so the builder's text,
 *                                       cards, and approval prompts reach the editor
 *
 * The task is the conversation so far, then the prompt, and the run's progress
 * events become the round lines, the check's card, the verdict thought, and
 * the summary that ends the turn (`./acp_progress.ts`). A run that fails ends
 * the turn with a summary saying so, rather than as an error, which would
 * leave it out of the session's history; a stopped turn still ends cancelled.
 *
 * Outside a container, unless the operator opted out, a person approving each
 * command takes the container's place: Auto isn't offered, so every builder
 * command and every check asks first in either mode that is. Neither sees the
 * keys the seats spend, and a session reaches the folder it opened on alone.
 *
 * The flags are checked once at startup, and every config error exits 5
 * before serving, so it shows in the editor's agent log once rather than
 * failing every prompt. Stdout carries the protocol alone: the run's renderer
 * writes to stderr, and `--json` is refused.
 */
import { tmpdir } from 'node:os';
import { step } from 'fascicle';
import type { RunContext, Step } from 'fascicle';
import type { AcpMode, AcpSession, AcpStreamRoute, AcpTurn, ServeAcpConfig } from 'fascicle/acp';
import {
  failure_event,
  follow_rounds,
  progress_updates,
  summary_event,
  turn_task,
} from './acp_progress.js';
import { acp_seat_tools } from './acp_tools.js';
import { resolve_config, unguarded_builder } from './config.js';
import { run_volley } from './orchestrator.js';
import type { OrchestratorDeps } from './orchestrator.js';
import type { CheckGate } from './phases.js';
import { create_renderer } from './render/renderer.js';
import { build_run_summary } from './summary.js';
import { config_error } from './types.js';
import type { ResolvedConfig, RunResult, VolleyConfig } from './types.js';

type Env = Record<string, string | undefined>;

/** `volley acp`'s flags as config: everything but the workspace and the task,
 * which each prompt supplies. */
type AcpFlags = Omit<VolleyConfig, 'prompt' | 'workspace' | 'criteria'>;

/** `--max-iterations` under acp. A prompt is one short exchange, which the
 * user can follow with another, and `--max-cost-usd` caps what a prompt
 * spends. */
export const ACP_MAX_ITERATIONS = 3;

/** The seat flags `volley acp` requires, by the config field each sets. The
 * CLI's defaults (`claude_cli` on `opus`) would refuse themselves here, and a
 * default hosted model would spend money on a model the editor's entry never
 * names. */
const REQUIRED_SEAT_FLAGS: ReadonlyArray<readonly [keyof AcpFlags, string]> = [
  ['builder_provider', '--builder-provider'],
  ['builder_model', '--builder-model'],
  ['critic_provider', '--critic-provider'],
  ['critic_model', '--critic-model'],
];

/** The run command's options `volley acp` declares only to refuse, by the
 * config field each sets, with the reason it gives. */
const REFUSED_FLAGS: ReadonlyArray<readonly [keyof AcpFlags, string, string]> = [
  ['worktree', '--worktree', 'a sibling worktree sits outside the project the editor has open'],
  [
    'git_checkpoints',
    '--git',
    'it commits to the open repo after every phase, which no permission prompt covers',
  ],
  ['json', '--json', 'stdout carries the protocol alone'],
];

/** What the startup check resolves in place of a prompt, which no session has
 * sent yet. */
const STAND_IN_TASK = 'volley acp: startup check';

/** Unset, or set to nothing but whitespace. Any other value goes on to
 * `resolve_config`, which says what's wrong with it. */
function is_blank(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.trim() === '');
}

/** A refusal or a missing seat flag, as one config error. */
function refuse_unservable(raw: AcpFlags): void {
  for (const [field, flag, reason] of REFUSED_FLAGS) {
    if (raw[field] === true) throw config_error(`volley acp refuses ${flag}: ${reason}`);
  }
  const missing = REQUIRED_SEAT_FLAGS.filter(([field]) => is_blank(raw[field])).map(
    ([, flag]) => flag,
  );
  if (missing.length > 0) {
    throw config_error(`volley acp requires every seat flag, and these are missing: ${missing.join(', ')}`);
  }
  if (raw.builder_provider === 'claude_cli') {
    throw config_error(
      'volley acp refuses a claude_cli builder: the Claude CLI runs its own tools under its own ' +
        "permission model, so its edits would never reach the editor's prompts",
    );
  }
}

/** The flags `volley acp` was started with, with acp's default filled in:
 * three rounds. Run state goes under the default root, outside the workspace,
 * unless `--state-dir` names one, as it does for any run. Each refusal, a
 * missing seat flag, and any other config error, an unwritable state root
 * among them, throws here, before serving: the whole config resolves once
 * against the system temp directory with a stand-in task, since no session has
 * named a workspace yet. */
export function acp_base_config(raw: AcpFlags, env: Env = process.env): AcpFlags {
  refuse_unservable(raw);
  const base: AcpFlags = {
    ...raw,
    max_iterations: raw.max_iterations ?? ACP_MAX_ITERATIONS,
  };
  resolve_config(
    { ...base, workspace: tmpdir(), prompt: STAND_IN_TASK, criteria: STAND_IN_TASK },
    { env, uncontained_builder: 'ask' },
  );
  return base;
}

/** One prompt's run config: the base flags resolved against the session's
 * workspace, with the turn as both the task and the criteria. Those two are
 * set after resolving, because resolving reads a value that starts with `@` as
 * a file to load, and text typed in the editor is never that. */
function turn_config(base: AcpFlags, workspace: string, task: string, env: Env): ResolvedConfig {
  const resolved = resolve_config(
    { ...base, workspace, prompt: STAND_IN_TASK, criteria: STAND_IN_TASK },
    { env, uncontained_builder: 'ask' },
  );
  return { ...resolved, prompt: task, criteria: task };
}

/** Only the builder's text is the reply. The critic's calls stream raw verdict
 * JSON, and nothing else in the run streams text. */
function stream_route(step_id: string): AcpStreamRoute {
  return step_id === 'builder' ? 'message' : 'none';
}

/** What one session's turns share: the flags, the environment each turn's
 * config reads, the session's workspace, both seats' tools, and how the check
 * runs. */
type TurnDeps = {
  base: AcpFlags;
  env: Env;
  workspace: string;
  seats: NonNullable<OrchestratorDeps['seats']>;
  check: CheckGate;
};

/** One prompt: a volley run on the session's workspace, its events flowing
 * into the turn's own trajectory, then its summary as the turn's last event.
 * A failure is summarized too, naming the round it reached, and the turn ends
 * normally, so the session's history keeps the request for a retry. A turn
 * whose own signal fired rethrows, and ends cancelled. Resolves to the run's
 * result, or null when it failed. */
async function run_turn(deps: TurnDeps, turn: AcpTurn, ctx: RunContext): Promise<RunResult | null> {
  const rounds = follow_rounds(ctx.trajectory);
  try {
    const config = turn_config(deps.base, deps.workspace, turn_task(turn), deps.env);
    const result = await run_volley(config, {
      renderer: create_renderer({
        mode: 'quiet',
        show_thinking: false,
        color: false,
        max_cost_usd: config.max_cost_usd,
      }),
      seats: deps.seats,
      check: deps.check,
      trajectory: rounds.sink,
      abort: ctx.abort,
      install_signal_handlers: false,
    });
    ctx.emit(summary_event(build_run_summary(config, result)));
    return result;
  } catch (err) {
    if (ctx.abort.aborted) throw err;
    ctx.emit(failure_event(err, rounds.round()));
    return null;
  }
}

/** The flow for one session: both seats' tools and the check's gate are
 * built once, from the session, and each prompt runs volley on the session's
 * `cwd` with them. */
function session_flow(
  base: AcpFlags,
  env: Env,
): (session: AcpSession) => Step<AcpTurn, RunResult | null> {
  return (session) => {
    const { builder, critic, check } = acp_seat_tools(session, { env });
    const deps: TurnDeps = { base, env, workspace: session.cwd, seats: { builder, critic }, check };
    return step('acp_turn', (turn: AcpTurn, ctx) => run_turn(deps, turn, ctx), {
      description: "one volley run on the session's workspace, per prompt",
    });
  };
}

type AcpServeOptions = {
  /** Reported to the client as the agent's version. */
  version: string;
  /** Where each turn's config reads its environment; default: the process's. */
  env?: Env;
};

/** The modes a session offers outside a container with no opt-out, where
 * nothing but a person stands between a command and the host: Auto, which
 * runs every command unasked, is left out. */
const HOST_MODES: ReadonlyArray<AcpMode> = ['manual', 'accept_edits'];

/** What `serve_acp` serves: volley, per session, starting each in Manual, on
 * the folder the session opened alone, since the check, the change list, and
 * the critic look nowhere else. The builder's streamed text and volley's own
 * lines make the whole reply, ending with the summary, so `to_text` adds
 * nothing. */
export function acp_serve_config(
  base: AcpFlags,
  options: AcpServeOptions,
): ServeAcpConfig<AcpTurn, RunResult | null> {
  const env = options.env ?? process.env;
  return {
    name: 'volley',
    version: options.version,
    default_mode: 'manual',
    additional_directories: false,
    ...(unguarded_builder(base, env) ? { modes: HOST_MODES } : {}),
    flow: session_flow(base, env),
    to_input: (turn) => turn,
    stream: stream_route,
    to_updates: progress_updates,
    to_text: () => '',
  };
}
