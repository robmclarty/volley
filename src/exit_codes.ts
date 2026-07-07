/**
 * Exit codes (spec §5) and the mapping from fascicle's error taxonomy plus
 * volley's own tagged errors onto them.
 */
import { error_kind } from './types.js';
import type { PhaseError, RunStatus } from './types.js';

export const EXIT_SUCCESS = 0;
export const EXIT_BUDGET_EXHAUSTED = 2;
export const EXIT_BUILDER_ERROR = 3;
export const EXIT_CHECK_ERROR = 4;
export const EXIT_CONFIG_ERROR = 5;
export const EXIT_CRITIC_ERROR = 6;
export const EXIT_COST_CAP = 7;
export const EXIT_INTERRUPTED = 130;

export function exit_code_for_status(status: RunStatus): number {
  switch (status) {
    case 'success':
      return EXIT_SUCCESS;
    case 'budget_exhausted':
      return EXIT_BUDGET_EXHAUSTED;
    case 'cost_cap_reached':
      return EXIT_COST_CAP;
    case 'interrupted':
      return EXIT_INTERRUPTED;
    default:
      return EXIT_BUILDER_ERROR;
  }
}

/** Error kinds fascicle raises for provider-level failures. */
const PROVIDER_ERROR_KINDS = new Set([
  'provider_error',
  'provider_auth_error',
  'provider_not_configured_error',
  'provider_capability_error',
  'claude_cli_error',
  'rate_limit_error',
  'engine_disposed_error',
  'timeout_error',
]);

export function exit_code_for_error(err: unknown): number {
  const kind = error_kind(err);
  if (kind === 'aborted_error') return EXIT_INTERRUPTED;
  if (kind === 'config_error' || kind === 'engine_config_error') {
    return EXIT_CONFIG_ERROR;
  }
  if (kind === 'check_error') return EXIT_CHECK_ERROR;
  if (kind === 'schema_validation_error') return EXIT_CRITIC_ERROR;
  if (kind === 'phase_error') {
    const phase = (err as PhaseError).phase;
    const cause_kind = error_kind((err as PhaseError).cause);
    if (cause_kind === 'aborted_error') return EXIT_INTERRUPTED;
    if (phase === 'critic') return EXIT_CRITIC_ERROR;
    if (phase === 'check') return EXIT_CHECK_ERROR;
    return EXIT_BUILDER_ERROR;
  }
  if (kind !== null && PROVIDER_ERROR_KINDS.has(kind)) {
    return EXIT_BUILDER_ERROR;
  }
  return EXIT_BUILDER_ERROR;
}
