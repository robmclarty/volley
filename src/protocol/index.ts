/**
 * The host protocols volley speaks on stdin and stdout, so a scheduler runs it
 * with no adapter of its own: today runciter's `runciter.run/1`
 * (`runciter_run.ts`).
 */
export {
  check_from_verify,
  CRITIC_FEEDBACK_ARTIFACT,
  fail_reason_of,
  input_to_config,
  result_to_output,
  run_input_schema,
  run_output_schema,
  SUMMARY_MAX_CHARS,
} from './runciter_run.js';
export type { RunciterRunInput } from './runciter_run.js';
