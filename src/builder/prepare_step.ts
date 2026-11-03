/**
 * The tool-loop builder's one `prepare_step` slot, shared by the hooks that
 * reshape a turn's request: the history trim, then the step countdown, whose
 * note goes last so it sits after everything a local runtime has cached.
 */
import type { PrepareStepHook } from 'fascicle';

/** One hook that runs `hooks` in order, each on the request the one before it
 * made, and reports no change when none of them made one. */
export function compose_prepare_steps(hooks: ReadonlyArray<PrepareStepHook>): PrepareStepHook {
  return async ({ step_index, messages }) => {
    let request = messages;
    let changed = false;
    for (const hook of hooks) {
      const prepared = await hook({ step_index, messages: request });
      if (prepared?.messages !== undefined) {
        request = prepared.messages;
        changed = true;
      }
    }
    return changed ? { messages: request } : undefined;
  };
}
