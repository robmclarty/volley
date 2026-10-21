/**
 * Public API surface: the `VolleyConfig` type for `volley.config.ts` files
 * plus the pieces a parent harness would embed.
 */
export { resolve_config, load_config_file, expand_at_file } from './config.js';
export { run_critique, run_volley } from './orchestrator.js';
export type { CritiqueDeps } from './orchestrator.js';
export { gate, initial_state, status_of } from './loop_state.js';
export { verdict_schema } from './critic/run.js';
export type { VerdictOutput } from './critic/run.js';
export { create_renderer } from './render/renderer.js';
export type { Renderer, RenderMode, RendererOptions } from './render/renderer.js';
// The sandbox invocation spec, so a harness that launches volley's container
// renders volley's own hardened argv rather than a copy that drifts from it.
export {
  network_run_args,
  sandbox_run_args,
  SANDBOX_NETWORK_NAME,
  SANDBOX_NETWORK_SUBNET,
  SANDBOX_STATE_ROOT,
} from './sandbox.js';
export type { SandboxNetwork } from './sandbox.js';
// The root a run keeps its state under by default, so a harness mounts the
// one volley uses on the host.
export { default_state_root } from './workspace.js';
export {
  exit_code_for_error,
  exit_code_for_status,
  EXIT_SUCCESS,
  EXIT_BUDGET_EXHAUSTED,
  EXIT_BUILDER_ERROR,
  EXIT_CHECK_ERROR,
  EXIT_CONFIG_ERROR,
  EXIT_CRITIC_ERROR,
  EXIT_COST_CAP,
  EXIT_INTERRUPTED,
} from './exit_codes.js';
export type {
  BuilderPermissionMode,
  CheckArtifact,
  CheckMode,
  CheckResult,
  CheckRunnerKind,
  CostSource,
  CriticPreset,
  CriticProvider,
  HaltReason,
  LoopState,
  PhaseRecord,
  ResolvedConfig,
  RunMode,
  RunResult,
  RunStatus,
  Verdict,
  VolleyConfig,
} from './types.js';
