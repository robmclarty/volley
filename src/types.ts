/**
 * Shared value and type contracts for volley (spec §3, §6).
 *
 * Type aliases are PascalCase; value-level identifiers are snake_case.
 * Fascicle's usage/cost types are used verbatim so summaries carry the
 * substrate's shapes, not a re-derivation.
 */
import type { FinishReason, UsageTotals } from 'fascicle';

export type Verdict = 'approved' | 'changes_requested';

export type CriticPreset = 'reviewer' | 'optimizer' | 'researcher';

/** Transport for the critic role. The critic is read-only + schema-constrained,
 * so it has always been able to run on a local model. */
export type CriticProvider = 'claude_cli' | 'ollama' | 'lmstudio';

/** Transport for the builder role. `claude_cli` is a full agentic Claude Code
 * session; the local providers run the builder as a volley-driven tool loop
 * (write/exec tools supplied by the harness). The execution path for the local
 * providers lands with the builder tool/termination work; this type and its
 * plumbing exist so that work has somewhere to attach (spec v3). */
export type BuilderProvider = 'claude_cli' | 'ollama' | 'lmstudio';

export type BuilderPermissionMode = 'acceptEdits' | 'bypassPermissions';

/** `auto`, `none`, or any shell command (the `string & {}` keeps the literal
 * hints in editor completions without collapsing the union). */
export type CheckMode = 'auto' | 'none' | (string & {});

export type CheckRunnerKind = 'checkride' | 'command' | 'none';

export type CostSource = 'provider_reported' | 'engine_derived' | 'unknown';

export type RunStatus =
  | 'running'
  | 'success'
  | 'budget_exhausted'
  | 'cost_cap_reached'
  | 'interrupted'
  | 'error';

/** User-facing configuration, before resolution (config file / flags). */
export type VolleyConfig = {
  prompt: string;
  workspace: string;
  criteria: string;
  check?: CheckMode;
  builder_model?: string;
  builder_provider?: BuilderProvider;
  builder_max_steps?: number;
  allow_unsandboxed_builder?: boolean;
  critic_model?: string;
  critic_provider?: CriticProvider;
  builder_permission_mode?: BuilderPermissionMode;
  critic?: CriticPreset | (string & {});
  max_iterations?: number;
  max_cost_usd?: number | null;
  git_checkpoints?: boolean;
  worktree?: boolean;
  sandbox_image?: string;
  verbose?: boolean;
  quiet?: boolean;
  json?: boolean;
  show_thinking?: boolean;
  dry_run?: boolean;
};

/** Fully resolved run configuration; `.volley/config.json` mirrors this. */
export type ResolvedConfig = {
  version: 2;
  run_id: string;
  started_at: string;
  prompt: string;
  criteria: string;
  check: CheckMode;
  check_resolved: CheckRunnerKind;
  builder_model: string;
  builder_provider: BuilderProvider;
  builder_max_steps: number;
  /** Operator opt-out permitting a local (non-`claude_cli`) builder to run
   * without a sandbox — it gets a real host bash. Refused by default (D11). */
  allow_unsandboxed_builder: boolean;
  critic_model: string;
  critic_provider: CriticProvider;
  builder_permission_mode: BuilderPermissionMode;
  critic_preset: CriticPreset | 'custom';
  critic_prompt_path: string | null;
  max_iterations: number;
  max_cost_usd: number | null;
  git_checkpoints: boolean;
  /** Isolate the builder run's effects in a per-run git worktree (s2 D3): the
   * builder/critic file tools' containment root moves to the worktree, while
   * `.volley/` state stays under `workspace` (the control plane). Off by
   * default; requires the workspace to be a git repository. */
  worktree: boolean;
  /** Container image the local-builder Docker sandbox runs (s2 D5). Defaults to
   * volley's own `Dockerfile`-built image; `--sandbox-image <tag>` /
   * `VOLLEY_SANDBOX_IMAGE` override it. Meaningful only for a local builder —
   * the `claude_cli` path never uses Docker (C4). */
  sandbox_image: string;
  workspace: string;
  verbose: boolean;
  quiet: boolean;
  json: boolean;
  show_thinking: boolean;
};

/** One failing check slot's raw artifact, for the critic prompt. */
export type CheckArtifact = {
  slot: string;
  path: string | null;
  content: string;
  truncated: boolean;
};

export type CheckResult = {
  ran: boolean;
  runner: CheckRunnerKind;
  ok: boolean;
  exit_code: number | null;
  duration_ms: number;
  failing_slots: string[];
  detail: CheckArtifact[];
  /** Raw checkride summary JSON (when the runner is checkride). */
  summary?: unknown;
  /** Captured combined output (when the runner is a shell command). */
  log?: string;
};

/** Per-phase record for iteration summaries (spec §3). */
export type PhaseRecord = {
  provider: string;
  model: string;
  session_id: string | null;
  duration_ms: number;
  usage: UsageTotals;
  cost_usd: number | null;
  cost_source: CostSource;
  /** How the phase's generate call ended (D6/D7). For a local builder,
   * `'max_steps'` is a budget cutoff surfaced as a warning, not an error. */
  finish_reason: FinishReason;
  /** Tool calls fascicle executed in this phase, and how many were recovered
   * from assistant text rather than returned structurally (D5) — the raw
   * counts behind the salvage-rate health metric. */
  tool_calls: number;
  salvaged_tool_calls: number;
};

export type HaltReason = 'cost_cap' | null;

/** Carry-state threaded through the fascicle loop. */
export type LoopState = {
  iteration: number;
  iteration_started_at: string;
  feedback: string | null;
  verdict: Verdict | null;
  unmet_criteria: string[];
  check: CheckResult | null;
  builder: PhaseRecord | null;
  critic: PhaseRecord | null;
  total_usage: UsageTotals;
  total_cost_usd: number;
  builder_cost_usd: number;
  critic_cost_usd: number;
  check_duration_ms: number;
  iteration_cost_usd: number;
  halt: HaltReason;
  cost_warned: boolean;
};

export type RunInput = {
  resume_from: LoopState | null;
};

/** Projection of final loop state; `.volley/summary.json` mirrors this. */
export type RunResult = {
  run_id: string;
  status: RunStatus;
  started_at: string;
  completed_at: string | null;
  iterations_completed: number;
  total_usage: UsageTotals;
  total_cost_usd: number;
  builder_cost_usd: number;
  critic_cost_usd: number;
  check_duration_ms: number;
  final_verdict: Verdict | null;
};

/** Recoverable domain failures surface as `kind`-tagged Error values (the
 * same discrimination style as fascicle's error taxonomy) so the top-level
 * handler maps them to exit codes without string matching or instanceof. */
export type VolleyErrorKind = 'config_error' | 'check_error' | 'phase_error';

export type VolleyPhase = 'builder' | 'critic' | 'check';

export type ConfigError = Error & { kind: 'config_error' };

export type CheckError = Error & { kind: 'check_error' };

export type PhaseError = Error & {
  kind: 'phase_error';
  phase: VolleyPhase;
  iteration: number;
  cause: unknown;
};

export function config_error(message: string): ConfigError {
  return Object.assign(new Error(message), { kind: 'config_error' as const });
}

export function check_error(message: string): CheckError {
  return Object.assign(new Error(message), { kind: 'check_error' as const });
}

/** Wraps a provider/schema failure with the phase and iteration it hit. */
export function phase_error(
  phase: VolleyPhase,
  iteration: number,
  cause: unknown,
): PhaseError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return Object.assign(
    new Error(`${phase} failed on iteration ${iteration}: ${detail}`),
    { kind: 'phase_error' as const, phase, iteration, cause },
  );
}

export function error_kind(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'kind' in err) {
    const kind = (err as { kind: unknown }).kind;
    return typeof kind === 'string' ? kind : null;
  }
  return null;
}
