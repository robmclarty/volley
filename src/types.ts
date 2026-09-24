/**
 * Shared value and type contracts for volley.
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

/** Fascicle's `provider_error.cause_kind` discriminant — why a provider call
 * died. Recorded alongside a critic retry so a degraded run says
 * *what* failed, not just that it retried. */
export type CauseKind = 'provider_5xx' | 'network' | 'unknown';

export type RunStatus =
  | 'running'
  | 'success'
  | 'budget_exhausted'
  | 'cost_cap_reached'
  /** The builder edited the gate that judges it, under `--fail-on-gate-edit`:
   * the run halts on the spot rather than iterating, because a check the builder
   * can rewrite is not evidence the work is done. */
  | 'gate_edit_blocked'
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
  discard_worktree?: boolean;
  gate_paths?: string[];
  fail_on_gate_edit?: boolean;
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
   * without a sandbox — it gets a real host bash. Refused by default. */
  allow_unsandboxed_builder: boolean;
  critic_model: string;
  critic_provider: CriticProvider;
  builder_permission_mode: BuilderPermissionMode;
  critic_preset: CriticPreset | 'custom';
  critic_prompt_path: string | null;
  max_iterations: number;
  max_cost_usd: number | null;
  git_checkpoints: boolean;
  /** Isolate the builder run's effects in a per-run git worktree: the
   * builder/critic file tools' containment root moves to the worktree, while
   * `.volley/` state stays under `workspace` (the control plane). Off by
   * default; requires the workspace to be a git repository. */
  worktree: boolean;
  /** Throw a `--worktree` run's effects away at teardown even when it converged:
   * the run branch is force-deleted rather than kept, because only the
   * verdicts are wanted. This is what `volley matrix` sweeps with — one config,
   * many builder×critic seats, no per-seat commits or branches left anywhere.
   * Refused without `--worktree`; `--git` still wins, so a `--worktree --git`
   * run integrates exactly as it always has. */
  discard_worktree: boolean;
  /** Glob patterns naming the *gate*: the tests, fixtures, and check
   * configuration that decide whether the builder's work passes. An edit to one
   * is reported to the critic and recorded in the summary — and refused outright
   * under `fail_on_gate_edit`. Defaults to `DEFAULT_GATE_PATTERNS`; a config's
   * own list replaces it, because what counts as the gate is the task's call
   * (a test-writing task edits tests by design). */
  gate_paths: string[];
  /** Halt the run when the builder edits a `gate_paths` match, instead of
   * reporting it and continuing. Off by default: a gate edit is legitimate often
   * enough that refusing it by default would break honest tasks, and the mark on
   * the summary already makes it impossible to miss. */
  fail_on_gate_edit: boolean;
  /** Container image the local-builder Docker sandbox runs. Defaults to
   * volley's own `Dockerfile`-built image; `--sandbox-image <tag>` /
   * `VOLLEY_SANDBOX_IMAGE` override it. Meaningful only for a local builder —
   * the `claude_cli` path never uses Docker. */
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

/** How one path changed between the run's baseline and the builder's output.
 * `renamed` covers git's rename/copy detection (the destination path is the one
 * recorded); `unknown` is any status git reports that none of these name. */
export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown';

/** One path the builder changed, and whether that path is part of the *gate* —
 * the tests, fixtures, and check configuration that decide whether the work
 * passes. A gate edit is not misconduct by itself (some tasks are *about* the
 * tests); it is the fact that makes a green check prove less. */
export type ChangedFile = {
  path: string;
  status: ChangeStatus;
  gate: boolean;
};

/** What the builder changed since the run's baseline, as the harness sees it
 * (`src/changes.ts`). Null in `LoopState` when the build root is not a git
 * repository — change detection is evidence, never a precondition. */
export type ChangeSet = {
  /** The commit the changes are measured against — the build root's HEAD before
   * the first iteration. Null in a repository with no commits yet, where only
   * untracked files can be reported. */
  baseline: string | null;
  /** The changed paths, sorted, capped at the collection limit. */
  files: ChangedFile[];
  /** Every gate-matching path — computed over the *full* list before the cap,
   * so truncation can never hide a gate edit. */
  gate_edits: string[];
  /** How many paths changed in total, before the cap. */
  total: number;
  truncated: boolean;
};

/** Per-phase record for iteration summaries. */
export type PhaseRecord = {
  provider: string;
  model: string;
  session_id: string | null;
  duration_ms: number;
  usage: UsageTotals;
  cost_usd: number | null;
  cost_source: CostSource;
  /** How the phase's generate call ended. For a local builder,
   * `'max_steps'` is a budget cutoff surfaced as a warning, not an error. */
  finish_reason: FinishReason;
  /** Tool calls fascicle executed in this phase, and how many were recovered
   * from assistant text rather than returned structurally — the raw
   * counts behind the salvage-rate health metric. */
  tool_calls: number;
  salvaged_tool_calls: number;
  /** Provider-error retries that preceded this phase's successful call
   * — the local-critic degradation ladder's first rung: a stochastic
   * Ollama stream death is retried once before falling back. Set on the critic
   * record (0 when the first call succeeded); absent on the builder, which is
   * not retried this build. Additive — old summary consumers ignore it. */
  retries?: number;
  /** The `cause_kind` of the retried provider error, recorded with `retries`.
   * Absent when no retry happened. */
  retry_cause_kind?: CauseKind;
  /** This local-critic verdict was rendered by the tool-less fallback rung:
   * the tool-bearing critique kept dying on the provider's stream
   * even after the bounded retry, so the critic judged with no read access —
   * grounded only by the criteria, the raw check artifacts, and a workspace file
   * inventory. Set (true) on a degraded critic record; absent on a full
   * critique and on the builder. Additive, and a degraded verdict is *always*
   * marked so it never passes silently as a full one. */
  critic_degraded?: boolean;
};

export type HaltReason = 'cost_cap' | 'gate_edit' | null;

/** Carry-state threaded through the fascicle loop. */
export type LoopState = {
  iteration: number;
  iteration_started_at: string;
  feedback: string | null;
  verdict: Verdict | null;
  unmet_criteria: string[];
  check: CheckResult | null;
  /** What the builder changed this iteration, measured against the run's
   * baseline (`src/changes.ts`). Null when the build root is not a git
   * repository, and before the first `build` step of a run. */
  changes: ChangeSet | null;
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
  /** The run branch teardown left behind because this run's work was never
   * integrated: under `--worktree` without `--git` a converged run has no
   * other copy of its effects, so teardown commits them onto `volley/<run id>`
   * and keeps the branch instead of force-deleting it. Null whenever nothing
   * survived — every non-worktree run, every integrated run, every discarded
   * one. `--json` consumers read it here; `.volley/summary.json` mirrors it. */
  salvaged_branch: string | null;
};

export type VolleyPhase = 'builder' | 'critic' | 'check';

/** Recoverable domain failures surface as `kind`-tagged Error values (the
 * same discrimination style as fascicle's error taxonomy) so the top-level
 * handler maps them to exit codes without string matching or instanceof. */
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
