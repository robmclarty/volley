/**
 * The tool-loop builder's step countdown. A model that explores first can
 * spend its whole budget before it verifies: in volley-41806476 the builder's
 * 50th step was a `bash` call fascicle refused, and the half-fixed tree went to
 * the check and critic. So for the last few steps of a session, each turn's
 * request ends with a note of how many are left and what to do with them.
 *
 * The note goes in through fascicle's `prepare_step`, which reshapes only what
 * one turn sends, so the transcript stays as the model wrote it, and the note
 * sits after everything a local runtime has cached, so its cached prefix holds.
 */
import type { PrepareStepHook } from 'fascicle';

/** How many of a session's last steps carry the countdown: five, or a tenth
 * of a long budget, but never more than half of it, so a short session still
 * starts without one. */
export function countdown_window(max_steps: number): number {
  return Math.min(Math.max(5, Math.ceil(max_steps / 10)), Math.floor(max_steps / 2));
}

/** The note for a turn with `steps_left` steps left, this one included.
 * `check` names how to run the check. On the last step fascicle runs only a
 * call that ends the session, which for the builder is `finish`. */
export function countdown_note(steps_left: number, check: string): string {
  if (steps_left <= 1) {
    return (
      '[volley] This is the last step of this session, and only finish runs on it. ' +
      "Call finish now, with a summary that says what's done and what isn't verified."
    );
  }
  return (
    `[volley] ${String(steps_left)} steps left in this session, this one included, ` +
    'and on the last one only finish runs. ' +
    `If you haven't run ${check} since your last edit, run it now, ` +
    'then fix what it reports or call finish.'
  );
}

/** The `prepare_step` hook that adds the countdown to a session of
 * `max_steps` steps. */
export function step_countdown(max_steps: number, check: string): PrepareStepHook {
  const window = countdown_window(max_steps);
  return ({ step_index, messages }) => {
    const steps_left = max_steps - step_index;
    if (steps_left > window) return undefined;
    return {
      messages: [...messages, { role: 'user', content: countdown_note(steps_left, check) }],
    };
  };
}
