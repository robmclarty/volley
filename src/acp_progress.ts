/**
 * What a volley turn reads from the editor's thread, and what it shows there.
 *
 * In: the turn's task is the conversation so far, oldest first, then the new
 * prompt. A stopped turn says so where it stopped, an earlier prompt's
 * attached files shrink to a line naming each (they are still on disk), and
 * an earlier reply keeps only its end, where the run's summary sits.
 *
 * Out: `progress_updates` wraps fascicle's `to_session_updates`, so every
 * event still reaches it, and adds what volley's own events say:
 *
 *   round_start          a **Round N** line in the reply
 *   the check's chunks   the card fascicle opens, given the look of a command:
 *                        titled with the command line, closed with its output
 *   verdict              a thought: the verdict, the feedback, the unmet criteria
 *   summary              the turn's last message: how the run ended, or failed
 *
 * `check_start` and `check_end` add nothing here, since the card says both.
 */
import { StringDecoder } from 'node:string_decoder';
import type { TrajectoryEvent, TrajectoryLogger } from 'fascicle';
import { to_session_updates } from 'fascicle/acp';
import type { AcpHistoryEntry, AcpMapperState, AcpTurn } from 'fascicle/acp';
import type { CheckrideSummary } from './check/checkride.js';
import { CHECK_STEP_ID } from './phases.js';
import type { PhaseEvent, VerdictEvent } from './phases.js';
import type { RunSummary } from './summary.js';
import { error_kind } from './types.js';
import type { CheckResult, PhaseError, RunStatus, Verdict, VolleyPhase } from './types.js';

type SessionUpdate = ReturnType<typeof to_session_updates>[number];

/** How a run that returned ended, read from its summary: whether it
 * converged, in how many rounds, with what last verdict, and what the editor
 * hears nowhere else (the unmet criteria, gate edits, a degraded verdict),
 * since stderr reaches only the agent log. */
export type FinishedSummary = {
  volley: 'summary';
  outcome: 'finished';
  status: RunStatus;
  rounds: number;
  verdict: Verdict | null;
  unmet_criteria: string[];
  gate_edits: string[];
  critic_degraded: boolean;
};

/** How a run that threw failed: the round it reached, the phase that threw,
 * when the error names one, and what went wrong. */
export type FailedSummary = {
  volley: 'summary';
  outcome: 'failed';
  round: number;
  phase: VolleyPhase | null;
  error: string;
};

type SummaryEvent = FinishedSummary | FailedSummary;

/** Everything volley emits that this module reads. */
type ProgressEvent = PhaseEvent | SummaryEvent;

/** What the model reads after the last text of a turn the user stopped, in
 * fascicle's acp-agent wording. */
const STOPPED = '[The user stopped this turn here. Leave what it asked for unless they ask again.]';

/** How much of an earlier reply the task keeps: its end, where the summary sits. */
export const AGENT_TAIL_CHARS = 2000;

/** The most of the check's output a card shows, as `run_command` cuts its own. */
export const CHECK_OUTPUT_LIMIT_BYTES = 32_000;

/** Where a turn's attached files start: fascicle puts each file's
 * `<context ref="…">` block after the prompt, a blank line before each. */
const FIRST_CONTEXT = '\n\n<context ref="';

/** The seam between two attached files' blocks. A file's own text can hold a
 * `</context>`, so a block ends only where the next one starts. */
const CONTEXT_SEAM = /\n<\/context>\n\n(?=<context ref=")/;

const VERDICT_WORDS: Record<Verdict, string> = {
  approved: 'approved',
  changes_requested: 'changes requested',
};

const PHASE_WORDS: Record<VolleyPhase, string> = {
  builder: 'the build',
  check: 'the check',
  critic: 'the critique',
};

function rounds(count: number): string {
  return `${String(count)} ${count === 1 ? 'round' : 'rounds'}`;
}

function verdict_words(verdict: Verdict | null): string {
  return verdict === null ? 'none' : VERDICT_WORDS[verdict];
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

/** An earlier prompt without its attached files' text, and a line naming each. */
function without_context(text: string): string {
  const start = text.indexOf(FIRST_CONTEXT);
  if (start === -1) return text;
  const refs = text
    .slice(start + 2)
    .split(CONTEXT_SEAM)
    .map((block) => `[attached: ${/^<context ref="([^"]*)">/.exec(block)?.[1] ?? 'a file'}]`);
  return [text.slice(0, start), ...refs].join('\n');
}

/** An earlier reply's end, marked as cut when it was. */
function agent_tail(text: string): string {
  return text.length <= AGENT_TAIL_CHARS ? text : `…${text.slice(-AGENT_TAIL_CHARS)}`;
}

function history_entry(entry: AcpHistoryEntry): string {
  const said =
    entry.role === 'user'
      ? `User: ${without_context(entry.text)}`
      : `Volley: ${agent_tail(entry.text)}`;
  return entry.cancelled === true ? `${said}\n\n${STOPPED}` : said;
}

/** A turn's task, and its criteria: the conversation so far, then the new
 * prompt with its attached files whole. A first turn is its prompt alone. */
export function turn_task(turn: AcpTurn): string {
  if (turn.history.length === 0) return turn.text;
  return [
    'The conversation so far, oldest first:',
    ...turn.history.map(history_entry),
    'The request now:',
    turn.text,
  ].join('\n\n');
}

/** The summary of a run that returned. */
export function summary_event(summary: RunSummary): FinishedSummary {
  return {
    volley: 'summary',
    outcome: 'finished',
    status: summary.status,
    rounds: summary.iterations_completed,
    verdict: summary.final_verdict,
    unmet_criteria: summary.comparison.unmet_criteria,
    gate_edits: summary.comparison.gate_edits,
    critic_degraded: summary.comparison.critic_degraded,
  };
}

function message_of(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The summary of a run that threw in `round` (0 before the first). A phase
 * error names its phase and carries the error underneath, which is the part
 * worth saying; a check error comes from the check. */
export function failure_event(err: unknown, round: number): FailedSummary {
  const kind = error_kind(err);
  if (kind === 'phase_error') {
    const { phase, cause } = err as PhaseError;
    return { volley: 'summary', outcome: 'failed', round, phase, error: message_of(cause) };
  }
  const phase = kind === 'check_error' ? 'check' : null;
  return { volley: 'summary', outcome: 'failed', round, phase, error: message_of(err) };
}

/** `sink`, and the last round a run started while recording through it, read
 * off its `round_start` events as they pass. */
export function follow_rounds(sink: TrajectoryLogger): {
  sink: TrajectoryLogger;
  round: () => number;
} {
  let round = 0;
  return {
    sink: {
      ...sink,
      record: (event) => {
        if (event.kind === 'emit' && event['volley'] === 'round_start') {
          const started = event['round'];
          if (typeof started === 'number') round = started;
        }
        sink.record(event);
      },
    },
    round: () => round,
  };
}

/** Text in a `console` code block whose fence outruns any backticks that
 * open one of its lines, so nothing the check printed can close it early. */
function console_block(text: string): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/^`+/gm), ([run]) => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}console\n${text}\n${fence}`;
}

/** At most `CHECK_OUTPUT_LIMIT_BYTES` of `text`, with a marker when it was
 * cut. A cut inside a character drops its partial bytes. */
function cut(text: string): string {
  const size = Buffer.byteLength(text);
  if (size <= CHECK_OUTPUT_LIMIT_BYTES) return text;
  const kept = new StringDecoder('utf8').write(
    Buffer.from(text).subarray(0, CHECK_OUTPUT_LIMIT_BYTES),
  );
  return `${kept}\n[output cut at ${String(CHECK_OUTPUT_LIMIT_BYTES)} bytes of ${String(size)}]`;
}

/** checkride's run as text: each slot and how it went, then each failing
 * slot's own output. */
function checkride_text(result: CheckResult): string {
  const checks = (result.summary as CheckrideSummary | undefined)?.checks ?? [];
  const slots = checks
    .map((check) => `${check.skipped === true ? 'skip' : check.ok ? 'ok  ' : 'FAIL'}  ${check.name}`)
    .join('\n');
  const outputs = result.detail.map(
    (artifact) =>
      `── ${artifact.slot} ──\n${artifact.content.trimEnd()}` +
      (artifact.truncated ? `\n[cut; the whole output is in ${artifact.path ?? 'the run state'}]` : ''),
  );
  return [slots, ...outputs].filter((part) => part !== '').join('\n\n');
}

/** What the check's card shows: what it printed, cut as `run_command`'s
 * output is, then how it exited. */
function check_text(result: CheckResult): string {
  const printed = (result.runner === 'checkride' ? checkride_text(result) : (result.log ?? '')).trimEnd();
  const exit = result.exit_code === null ? '[ended by a signal]' : `[exit code ${String(result.exit_code)}]`;
  return `${printed === '' ? '[no output]' : cut(printed)}\n${exit}`;
}

function as_record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** One of the check card's updates, given a command's look: opened as an
 * `execute` card, titled with the command line once its input arrives, and
 * closed `completed` or `failed` with its output. A check that threw closes
 * as fascicle closes any failed call, with the error's text. */
function dress_check_update(update: SessionUpdate, chunk: Record<string, unknown>): SessionUpdate {
  if (update.sessionUpdate === 'tool_call') return { ...update, kind: 'execute' };
  if (update.sessionUpdate !== 'tool_call_update') return update;
  if (chunk['kind'] === 'tool_call_end') {
    const command = as_record(chunk['input'])['command'];
    return typeof command === 'string' ? { ...update, title: command } : update;
  }
  if (chunk['kind'] !== 'tool_result' || chunk['error'] !== undefined) return update;
  const result = chunk['output'] as CheckResult;
  return {
    ...update,
    status: result.ok ? 'completed' : 'failed',
    rawOutput: { ok: result.ok, exit_code: result.exit_code, failing_slots: result.failing_slots },
    content: [{ type: 'content', content: { type: 'text', text: console_block(check_text(result)) } }],
  };
}

function message(text: string): SessionUpdate {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } };
}

function thought(text: string): SessionUpdate {
  return { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } };
}

/** A round's opening line, apart from the reply before it. */
function round_line(round: number): string {
  return `${round === 1 ? '' : '\n\n'}**Round ${String(round)}**\n\n`;
}

/** The critic's verdict as a thought: the verdict, the feedback, and what it
 * still found missing. */
function verdict_text(event: VerdictEvent): string {
  const head = `**Round ${String(event.round)} verdict: ${verdict_words(event.verdict)}**`;
  const parts = [
    event.degraded ? `${head} (judged without its tools)` : head,
    event.feedback.trim(),
    event.unmet_criteria.length > 0 ? `Unmet criteria:\n${bullets(event.unmet_criteria)}` : '',
  ];
  return `\n\n${parts.filter((part) => part !== '').join('\n\n')}`;
}

const ENDINGS: Partial<Record<RunStatus, (count: number) => string>> = {
  success: (count) => `**Converged** in ${rounds(count)}.`,
  budget_exhausted: (count) => `**Not converged** after ${rounds(count)}, the most this run allows.`,
  cost_cap_reached: (count) => `**Not converged**: the run reached its cost cap after ${rounds(count)}.`,
  gate_edit_blocked: (count) =>
    `**Stopped** after ${rounds(count)}: the builder edited the gate, and --fail-on-gate-edit ends the run.`,
};

function finished_text(event: FinishedSummary): string {
  const ending =
    ENDINGS[event.status]?.(event.rounds) ?? `**Ended ${event.status}** after ${rounds(event.rounds)}.`;
  const converged = event.status === 'success';
  return [
    `${ending} Last verdict: ${verdict_words(event.verdict)}.`,
    !converged && event.unmet_criteria.length > 0
      ? `Still unmet:\n${bullets(event.unmet_criteria)}`
      : '',
    event.gate_edits.length > 0
      ? `The builder edited files that decide whether its work passes: ${event.gate_edits.join(', ')}.`
      : '',
    event.critic_degraded
      ? 'At least one verdict came from a critic that judged without its tools, so it saw less than usual.'
      : '',
  ]
    .filter((part) => part !== '')
    .join('\n\n');
}

function failed_text(event: FailedSummary): string {
  const where = event.round === 0 ? 'before the first round' : `in round ${String(event.round)}`;
  const during = event.phase === null ? '' : `, during ${PHASE_WORDS[event.phase]}`;
  return `**Run failed** ${where}${during}: ${event.error}`;
}

/** The turn's last message: how the run ended, or how it failed. */
function summary_text(event: SummaryEvent): string {
  return `\n\n${event.outcome === 'finished' ? finished_text(event) : failed_text(event)}`;
}

/** An `emit` event's payload, when volley emitted it. */
function progress_event(event: TrajectoryEvent): ProgressEvent | null {
  return event.kind === 'emit' && typeof event['volley'] === 'string'
    ? (event as unknown as ProgressEvent)
    : null;
}

function progress_of(event: ProgressEvent): SessionUpdate[] {
  switch (event.volley) {
    case 'round_start':
      return [message(round_line(event.round))];
    case 'verdict':
      return [thought(verdict_text(event))];
    case 'summary':
      return [message(summary_text(event))];
    case 'check_start':
    case 'check_end':
      return [];
  }
}

/** volley's `to_updates`: fascicle's own mapping for every event, the check's
 * card dressed as a command, and volley's progress events added. */
export function progress_updates(event: TrajectoryEvent, state: AcpMapperState): SessionUpdate[] {
  const updates = to_session_updates(event, state);
  if (event.kind === 'model_chunk' && event['step_id'] === CHECK_STEP_ID) {
    const chunk = as_record(event['chunk']);
    return updates.map((update) => dress_check_update(update, chunk));
  }
  const progress = progress_event(event);
  return progress === null ? updates : [...updates, ...progress_of(progress)];
}
