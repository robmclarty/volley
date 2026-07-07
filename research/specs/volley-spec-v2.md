# volley — Specification (v2)

A CLI harness that runs a builder/critic loop until a task passes both a deterministic check pipeline and a natural-language acceptance review.

This document supersedes [volley-spec.md](./volley-spec.md), which is retained unchanged for historical reference. v1 was specified directly against `@anthropic-ai/claude-agent-sdk` and hand-rolled its own loop, cost tracking, check runner, and streaming renderer. v2 respecifies volley on two substrates that have since matured:

- **fascicle** (v0.8.12) — the agent-composition library. Supplies the loop primitive, the `claude_cli` provider that drives full agentic Claude Code sessions, usage/cost accounting with a pricing table, trajectory logging, streaming chunks, and cancellation.
- **checkride** (v0.1.6) — the verification harness. Supplies the deterministic check: one command, exit 0 = done, plus a stable `.check/summary.json` artifact contract and raw per-tool JSON the critic can read directly.

## Revision notes — what changed from v1

| Area | v1 | v2 |
|---|---|---|
| Agent invocation | `@anthropic-ai/claude-agent-sdk` `query()` per role | fascicle `engine.generate()` with the `claude_cli` provider; one call = one complete agentic session in the workspace |
| Loop | Hand-rolled `for` loop | fascicle `loop` primitive (`init`/`body`/`guard`/`finish`/`max_rounds`); non-convergence is data, not an error |
| Critic output | Critic writes `.volley/feedback.md` + `.volley/verdict` files, enforced by `canUseTool` callback | Critic returns a **schema-validated structured verdict** (zod → `--json-schema`); the harness writes the files. Verdict-file failure modes disappear |
| Critic containment | Soft permission callback + system-prompt discipline; Bash was a soft boundary | Read-only tool allowlist at the CLI layer (`--allowedTools Read,Grep,Glob` + `--disallowedTools`); critic has no write path at all |
| Check | Arbitrary `--check "<shell command>"`, exit-0 semantics, stdout/stderr log | checkride is the blessed default (auto-detected); structured `.check/summary.json` gate + raw per-slot JSON fed to the critic. Arbitrary commands still supported |
| Cost tracking | Bespoke pricing table (`src/pricing.ts`), `compute_cost`, `cost_source` | fascicle `GenerateResult.usage`/`cost` (`CostBreakdown`), engine pricing table + `register_price` overrides; claude_cli cost is CLI-reported |
| Streaming | Bespoke message-grained renderer over SDK messages | `on_chunk` token/tool streaming (`StreamChunk`) + trajectory events; jsonl archival via `filesystem_logger` |
| Message logs | `builder.messages.jsonl` / `critic.messages.jsonl` per iteration | One run-level `.volley/trajectory.jsonl` (fascicle wire format, run_id/ts/span-stamped) |
| Auth | Subscription OAuth or API key; API-key warning | Same mechanics via `claude_cli` `auth_mode`, but reframed for Anthropic's 2026-06-15 programmatic-billing change: unattended runs are metered, so the cost cap is first-class |
| Runtime | Node 20, CJS-agnostic | Node ≥ 24, ESM-only, pnpm (fascicle floor; checkride needs ≥ 22.18) |
| Provider scope | Anthropic-only by construction (Agent SDK) | Anthropic-only by policy in v2 (claude_cli); the fascicle engine seam makes multi-provider a config change later (ridgeline has already validated this path) |

The sibling narrative also strengthened: ridgeline (volley's declared sibling) migrated onto fascicle in its v0.12.x line — engine, provider routing, and cost accounting all delegated. volley v2 shares that substrate instead of re-deriving it.

---

## §1 — Problem Statement

Complex agentic coding tasks benefit from iteration: a first pass rarely hits every constraint, and a reviewing pass catches mistakes, gaps, and missed acceptance criteria that the builder missed under its own attention budget. Today, this iteration is either manual (human running Claude Code, reading output, pasting feedback, running again) or embedded in bespoke harnesses like ridgeline that hardcode a plan/build/evaluate sequence for a specific job shape.

The user wants a minimal, general-purpose loop harness: prompt in, build, review, repeat until reviewer and check both pass. The builder is an agent given autonomy over a workspace. The critic is pluggable. Swapping the critic role changes what the loop does: a reviewer drives the loop toward an acceptance target, an optimizer drives it toward improvement plateau, a researcher drives it toward coverage completeness. Same harness, different objective function.

The secondary goal is architectural clarity. volley is deliberately a sibling to ridgeline, not a replacement. ridgeline fixes plan/build/evaluate as three phases with strong context boundaries between them. volley collapses plan into the builder's own autonomy and makes evaluation fully pluggable. Where ridgeline is opinionated about phase structure, volley is opinionated about role separation and nothing else.

New in v2: volley is also a proving ground for the substrate thesis. If fascicle's primitives are right, volley should feel like assembly — a `loop` around two `generate` calls and a check spawn — not like framework-fighting. The delta between this spec and v1 is a direct measure of how much harness plumbing the substrate absorbed.

## §2 — Solution Overview

volley is a TypeScript CLI built on fascicle. It runs a two-role loop until a stopping condition is met.

### Roles

**Builder**: One `engine.generate()` call per iteration against the `claude_cli` provider with `default_cwd` = the workspace. The Claude Code CLI runs its full internal agentic tool loop (Read/Write/Edit/Bash) within that one invocation and returns when done. Receives the task prompt, the acceptance criteria, and optionally the previous iteration's critic feedback. Modifies the workspace autonomously.

**Critic**: One `engine.generate()` call per iteration against the same provider and workspace, restricted to read-only tools (`Read`, `Grep`, `Glob`), with a zod verdict schema passed through `--json-schema`. Evaluates the workspace against acceptance criteria and check results, and returns `{ verdict, feedback }` as validated structured output. The harness — not the critic — persists `feedback.md` and `verdict` to `.volley/` for the audit trail and the next iteration.

### Loop shape

The loop is fascicle's `loop` primitive; volley supplies `init`, `body`, `guard`, and `finish`.

```
state = { iteration: 0, feedback: null, verdict: null, check: null,
          total_cost_usd: 0, halt: null }

body (Step<state, state>):
  iteration += 1
  run builder(prompt, criteria, feedback)            # engine.generate, claude_cli
  optional git commit "volley iter N: build"
  run check                                          # checkride --json, or custom command
  run critic(criteria, check result, workspace)      # engine.generate, schema output
  optional git commit "volley iter N: critique (verdict)"
  persist .volley/feedback.md, .volley/verdict
  archive iteration artifacts to .volley/iterations/NNN/
  accumulate usage + cost into state

guard (Step<state, {stop, state}>):
  if check.ok and verdict == approved      -> stop (converged)
  if cost cap set and total >= cap         -> stop, state.halt = cost_cap
  else                                     -> continue

finish: project state to RunResult
max_rounds: config.max_iterations
```

`loop` returns `{ value, converged, rounds }`. `converged: true` with no halt reason is success; exhausting `max_rounds` is budget exhaustion; a `halt` of `cost_cap` maps to the cost-cap exit code. Non-convergence is data, never an exception — the exception paths are reserved for real failures (provider errors, schema failures, workspace errors).

The whole loop is executed by a single `run(flow, input, { trajectory, abort })` call. fascicle installs SIGINT/SIGTERM handlers, threads the abort signal between rounds, and runs cleanup handlers (engine disposal) LIFO on success, failure, or interrupt.

**Why `loop` and not `adversarial`.** fascicle's `adversarial` primitive is exactly a build/critique/accept loop and threads `prior` + `critique` into the next build — a natural fit on paper. Two mismatches keep volley on the lower-level `loop`: (a) volley's stop condition is not a pure predicate over the critique result — it also folds in the deterministic check and the cost cap, and needs to record *which* condition stopped the loop; (b) volley archives per-iteration artifacts and enforces the cap between phases, which wants explicit carry-state. `adversarial` is itself implemented on `loop`, so nothing is lost; fascicle's own pr-improve example makes the same choice for the same reason.

### Architecture diagram

```
                   ┌──────────────────┐
   CLI invocation  │   volley loop    │   fascicle run( loop({...}) )
  ───────────────> │   orchestrator   │
                   └────────┬─────────┘
                            │
          ┌─────────────────┼─────────────────┐
          ▼                 ▼                 ▼
   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
   │   builder    │  │    check     │  │    critic    │
   │ engine.      │  │  checkride   │  │ engine.      │
   │ generate()   │  │  --json      │  │ generate()   │
   │ claude_cli,  │  │  (or custom  │  │ claude_cli,  │
   │ full tools,  │  │   command)   │  │ read-only +  │
   │ cwd=workspace│  │              │  │ verdict via  │
   │              │  │              │  │ --json-schema│
   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
          │                 │                 │
          ▼                 ▼                 ▼
   ┌─────────────────────────────────────────────────┐
   │                  workspace                      │
   │  <project files>                                │
   │  .check/             ← checkride writes         │
   │  .volley/                                       │
   │    feedback.md       ← harness writes           │
   │    verdict           ← harness writes           │
   │    trajectory.jsonl  ← fascicle filesystem_logger│
   │    iterations/NNN/   ← orchestrator archives    │
   │    config.json       ← resolved run config      │
   └─────────────────────────────────────────────────┘
```

Fresh context is strict: each builder invocation and each critic invocation is a fresh `claude_cli` session (no `session_id` reuse across iterations). State flows between iterations exclusively through the workspace filesystem and the loop's carry-state. This is the same context-hygiene discipline ridgeline enforces. It makes each iteration independently reproducible and debuggable.

### Live monitoring

Long-running autonomous loops need an active observation channel. Two features support this, both delegated:

**Streaming output.** Each `generate` call receives an `on_chunk` callback; the `claude_cli` provider forwards the CLI's `stream-json` events as typed `StreamChunk`s (`text`, `reasoning`, `tool_call_start`, `tool_call_input_delta`, `tool_call_end`, `tool_result`, `step_finish`, `finish`). volley's renderer formats these to the terminal as they arrive. The operator can read along, verify the agent is doing sensible work, and interrupt with SIGINT if it is not. Trajectory events continue to be written to jsonl in parallel, so streaming is a display concern, not a storage concern. (v1 was message-grained; chunk-grained streaming comes free with the substrate.)

**Cost and token tracking.** Every `GenerateResult` carries `usage` (`UsageTotals`) and `cost` (`CostBreakdown`, `is_estimate: true`). For `claude_cli`, cost comes from the CLI's own `total_cost_usd` (`source: provider_reported`); for other providers it is derived from the engine's pricing table (`engine_derived`). volley accumulates these into loop state, prints live counters, and enforces `--max-cost-usd` in the loop guard.

## §3 — Filesystem Data Model

volley is not a database-backed system; its persistent state is a directory layout inside the user's workspace.

### Workspace layout during a run

```
<workspace>/
  <user's project files>            # whatever the builder works on
  .claude/                          # optional, user-provided; discovered by the
    skills/                         #   CLI via setting_sources ['project','local']
  .check/                           # checkride's artifact dir (if checkride is the check)
    summary.json
    <slot>.json / <slot>.stdout.txt
  .volley/
    config.json                     # resolved run config (see below)
    summary.json                    # run-level aggregated usage and cost
    trajectory.jsonl                # every fascicle trajectory event, whole run
    feedback.md                     # current iteration's feedback (harness writes)
    verdict                         # "approved" | "changes_requested" (harness writes)
    iterations/
      001/
        feedback.md                 # archived copy
        verdict                     # archived copy
        check/                      # archived check artifacts:
          summary.json              #   checkride summary (or check.log + check.exit
          <failing-slot>.json       #   for custom commands)
        summary.json                # per-iteration timing, usage, cost, verdict
      002/
        ...
```

Changes from v1: `feedback.md` and `verdict` are now **harness-written** projections of the critic's structured output (kept because they are useful to humans, to `resume`, and to the next builder prompt — the protocol just no longer depends on the critic's file-writing discipline). Per-role `*.messages.jsonl` files are replaced by one run-level `trajectory.jsonl` in fascicle's wire format — every event is stamped with `run_id`, `ts` (epoch ms), and span ids, and iterations are demarcated by spans, so per-iteration views are a `jq` filter, not a storage layout.

### .volley/iterations/NNN/summary.json

Written when an iteration completes (builder + check + critic all done). Shape (usage/cost fields are fascicle's types verbatim):

```json
{
  "iteration": 1,
  "started_at": "<iso8601>",
  "completed_at": "<iso8601>",
  "duration_ms": 45231,
  "builder": {
    "provider": "claude_cli",
    "model": "opus",
    "session_id": "<claude session uuid>",
    "duration_ms": 28500,
    "usage": {
      "input_tokens": 15234,
      "output_tokens": 2103,
      "cached_input_tokens": 42100,
      "cache_write_tokens": 8500
    },
    "cost_usd": 0.287,
    "cost_source": "provider_reported"
  },
  "check": {
    "ran": true,
    "runner": "checkride",
    "ok": true,
    "exit_code": 0,
    "duration_ms": 2300,
    "failing_slots": []
  },
  "critic": {
    "provider": "claude_cli",
    "model": "opus",
    "session_id": "<claude session uuid>",
    "duration_ms": 14431,
    "usage": { "...": "..." },
    "cost_usd": 0.091,
    "cost_source": "provider_reported"
  },
  "verdict": "approved",
  "iteration_cost_usd": 0.378,
  "iteration_total_cost_usd": 0.711
}
```

`cost_source` uses fascicle's taxonomy: `provider_reported` when the cost came from the provider (the `claude_cli` path — the CLI reports `total_cost_usd`), `engine_derived` when computed from token counts against the engine's pricing table, `unknown` when neither was available (cost recorded as `null`).

`usage` follows fascicle's `UsageTotals`: `input_tokens`, `output_tokens`, plus optional `cached_input_tokens`, `cache_write_tokens`, `reasoning_tokens` — optional fields are present only when the provider reported them.

### .volley/summary.json (run-level)

Updated after each completed iteration and finalized at run end. Shape:

```json
{
  "run_id": "<uuid>",
  "status": "running | success | budget_exhausted | cost_cap_reached | interrupted | error",
  "started_at": "<iso8601>",
  "completed_at": "<iso8601 | null>",
  "iterations_completed": 3,
  "total_usage": {
    "input_tokens": 52341,
    "output_tokens": 8230,
    "cached_input_tokens": 189400,
    "cache_write_tokens": 28100
  },
  "total_cost_usd": 1.342,
  "builder_cost_usd": 1.067,
  "critic_cost_usd": 0.275,
  "check_duration_ms": 6900,
  "final_verdict": "approved | changes_requested | null"
}
```

### .volley/config.json

Written once at run start, immutable for the duration of the run. Contains the resolved configuration after merging CLI flags, config file, and defaults. Used by the orchestrator for resumption and by iterations for reproducibility reference.

```json
{
  "version": 2,
  "run_id": "<uuid>",
  "started_at": "<iso8601>",
  "prompt": "<string>",
  "criteria": "<string>",
  "check": "auto | none | <shell command>",
  "check_resolved": "checkride | command | none",
  "builder_model": "opus",
  "critic_model": "opus",
  "builder_permission_mode": "acceptEdits",
  "critic_preset": "reviewer | optimizer | researcher | custom",
  "critic_prompt_path": "<string | null>",
  "max_iterations": 10,
  "max_cost_usd": null,
  "git_checkpoints": false,
  "workspace": "<absolute path>"
}
```

### .volley/verdict and .volley/feedback.md

`verdict` contains exactly `approved` or `changes_requested`, trailing newline permitted. `feedback.md` is free-form markdown, passed verbatim into the next builder prompt.

Both files are **written by the harness** from the critic's validated structured output. Because a zod schema constrains the critic's response at the provider layer (with fascicle's `schema_repair_attempts` retrying malformed output before failing), the v1 failure modes "critic wrote an invalid verdict value", "critic forgot the verdict file", and "verdict file is empty" cannot occur by construction. A critic that cannot produce a valid verdict at all surfaces as a schema-validation error from `generate` (exit 6).

## §4 — Authentication and Authorization

volley is a local CLI tool. No authentication layer of its own.

The `claude_cli` provider drives the locally installed `claude` binary and supports three `auth_mode`s: `auto` (default — use whatever the CLI is configured with), `oauth` (subscription login; inherits the user's environment), and `api_key`. volley exposes this as config passthrough and defaults to `auto`.

**Billing reality (post 2026-06-15).** Anthropic's programmatic-billing change means unattended/programmatic invocations are metered even for subscription users — the v1 assumption that a Max subscription makes loop iterations effectively free no longer holds. Consequences for volley:

- The `--max-cost-usd` cap is promoted from nice-to-have to a first-class operational control; the README must lead with it.
- volley still surfaces the v1 warning when `ANTHROPIC_API_KEY` is set (the CLI will bill against the key rather than the subscription), but the framing is "know which meter you're on", not "avoid the meter".
- Per-run cost reporting (`.volley/summary.json`) is the artifact users will actually check; keep it accurate and prominent in the final terminal summary.

### Critic permission scope

The critic must not modify the workspace. v2 enforces this at the Claude Code CLI's own permission layer instead of a bespoke callback:

- `allowed_tools: ['Read', 'Grep', 'Glob']` — fascicle's tool bridge (`tool_bridge: 'allowlist_only'`, the default) turns these into `--allowedTools Read Grep Glob`. Only these are pre-approved.
- `extra_args: ['--disallowedTools', 'Write,Edit,MultiEdit,NotebookEdit,Bash']` — defense in depth; write-capable tools are explicitly denied rather than merely not-approved.
- Headless mode (`claude -p`) auto-denies any tool that would otherwise prompt, so there is no interactive escape hatch.

The critic has **no write path at all** — the verdict travels back as schema-constrained structured output, not as files. The v1 "Bash is a soft boundary" caveat is gone because the critic no longer gets Bash; anything the critic legitimately needed Bash for (grep, find, cat) is covered by `Read`/`Grep`/`Glob`. If a future critic preset genuinely needs command execution, the escape hatch is a per-preset `allowed_tools` override plus the sandboxed-worktree option (§13), not a relaxation of the default.

The builder runs with `--permission-mode acceptEdits` (default) and a pre-approved tool set including `Bash`; `--builder-permission-mode bypassPermissions` is available for fully trusted workspaces. Note the permission mode travels via `provider_options.claude_cli.extra_args` — fascicle's argv builder has no first-class permission-mode option, and volley must own this flag placement.

## §5 — CLI Interface

### Command

```
volley [options]
volley --config <path>
volley resume <run-id>
```

### Primary mode: direct invocation

```
volley \
  --prompt "<string or @file>" \
  --workspace <path> \
  --criteria "<string or @file>" \
  [--check auto|none|"<shell command>"] \
  [--builder-model <model>] \
  [--critic-model <model>] \
  [--critic <preset-name or path>] \
  [--max-iterations <n>] \
  [--max-cost-usd <usd>] \
  [--git] \
  [--dry-run]
```

### Options

| Flag | Required | Default | Description |
|---|---|---|---|
| `--prompt` | yes | — | The task prompt. Literal string, or `@path/to/file.md` to read from file. |
| `--workspace` | yes | — | Path to the workspace directory. Must exist. Must be writable. |
| `--criteria` | yes | — | Acceptance criteria as natural language. Literal string or `@path`. |
| `--check` | no | `auto` | `auto`: use checkride if detected in the workspace (see below), else no check. `none`: skip the deterministic check. Any other string: run as a shell command via `sh -c`, exit-0 semantics. |
| `--builder-model` | no | `opus` | Model for the builder. `opus`/`sonnet`/`haiku` aliases resolve inside the Claude CLI; full model IDs pass through verbatim. |
| `--critic-model` | no | `opus` | Model for the critic role. |
| `--builder-permission-mode` | no | `acceptEdits` | `acceptEdits` or `bypassPermissions`, forwarded to the builder's CLI session. |
| `--critic` | no | `reviewer` | One of `reviewer`, `optimizer`, `researcher`, or a path to a custom system prompt markdown file. |
| `--max-iterations` | no | 10 | Hard cap on iteration count (`loop`'s `max_rounds`). |
| `--max-cost-usd` | no | null | Hard USD ceiling, enforced in the loop guard. No cap if unset. |
| `--git` | no | false | Auto-commit after each phase to the workspace git repo. Requires workspace to be a git repo. |
| `--dry-run` | no | false | Validate config, run `checkride doctor` if checkride is the resolved check, and exit without running the loop. |
| `--config` | no | — | Path to a TypeScript config file exporting a `VolleyConfig` object. CLI flags override. |
| `--json` | no | false | Machine mode: suppress human streaming on stderr; print the final run summary JSON on stdout. |
| `--verbose` | no | false | Show full tool inputs and outputs (truncated at 4000 chars with a pointer to the jsonl log). |
| `--quiet` | no | false | Suppress chunk streaming. Show only phase transitions, cost updates, and final summary. |
| `--no-thinking` | no | false | Hide `reasoning` chunks from streamed output. They are still recorded in the trajectory. |

Removed from v1: `--skills-dir` (the CLI discovers `.claude/skills/` itself via `setting_sources: ['project', 'local']`, which volley always passes); `--no-stream` (subsumed by `--quiet` and `--json`).

**Check auto-detection.** `--check auto` resolves to checkride when the workspace has a `checkride.config.json`, or a `package.json` whose `scripts.check` is `checkride`, or `node_modules/.bin/checkride`. When resolved, volley runs `pnpm exec checkride --json`. Checkride requires the workspace to be a pnpm project with its tools installed as devDependencies; `volley --dry-run` runs `checkride doctor` to verify this before burning model spend.

### Output stream conventions

Adopted from checkride: **human-readable progress goes to stderr; stdout carries machine output only.** Under `--json`, stdout is exactly one JSON document (the run summary, mirroring `.volley/summary.json`). In the default mode stdout is empty and safe to pipe. This lets volley itself be composed under a bigger harness the same way volley composes checkride.

### Subcommand: resume

```
volley resume <run-id>
```

Resumes a run from the last completed iteration. Reads `.volley/config.json` to recover settings. Continues from `iteration = last_completed + 1` with `.volley/feedback.md` as the incoming feedback. If the last iteration was interrupted mid-phase, that iteration is discarded and re-run. The cost accumulator resumes from the run-level summary's totals.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success: check passed and verdict is approved. |
| 2 | Budget exhausted: max iterations reached without success. |
| 3 | Builder error: provider failure (CLI not found, startup/stall timeout, auth) or unrecoverable session error. |
| 4 | Check error: command not found, spawn failure, or checkride exited 2 (harness/usage error, as distinct from checks failing). |
| 5 | Configuration error: missing required flag, invalid model/preset, workspace not writable, `--git` without repo, checkride doctor failure under `--dry-run`. |
| 6 | Critic error: schema validation failed after fascicle's repair attempts, or the critic session itself errored. |
| 7 | Cost cap reached: `--max-cost-usd` exceeded. |
| 130 | Interrupted by SIGINT. Partial iteration state is preserved. |

Checkride's exit codes map cleanly: 0 → check passed, 1 → check failed (loop continues, critic informed), 2 → volley exit 4 (a broken check pipeline is an operator problem, not something to iterate on).

### Config file format

```ts
// volley.config.ts
import type { VolleyConfig } from 'volley';

const config: VolleyConfig = {
  prompt: '...',
  workspace: './my-project',
  criteria: '...',
  check: 'auto',
  builder_model: 'opus',
  critic_model: 'sonnet',
  critic: 'reviewer',
  max_iterations: 10,
  max_cost_usd: 20.0,
  git_checkpoints: false,
  verbose: false,
  show_thinking: true,
};

export default config;
```

## §6 — Business Logic

### Loop orchestration

The orchestrator composes a fascicle flow and executes it with a single `run` call. No classes, no framework lifecycle. Pseudocode:

```ts
async function run_volley(config: VolleyConfig): Promise<RunResult> {
  await initialize_workspace(config);          // .volley/ dir, .bak rotation, git checks
  write_resolved_config(config);

  const engine = create_engine({
    providers: {
      claude_cli: {
        default_cwd: config.workspace,
        setting_sources: ['project', 'local'],
        // binary, auth_mode, timeouts overridable via env/config
      },
    },
  });

  const flow = loop<RunInput, LoopState, RunResult>({
    name: 'volley',
    init: (input) => initial_state(input),
    body: sequence([
      step('build', (s) => run_builder(engine, config, s)),
      step('check', (s) => run_check(config, s)),
      step('critique', (s) => run_critic(engine, config, s)),
      step('record', (s) => archive_iteration(config, s)),   // feedback.md, verdict,
    ]),                                                      // iteration summary, cost totals
    guard: step('gate', (s) => ({
      stop: (s.check.ok && s.verdict === 'approved') || cost_cap_hit(config, s),
      state: mark_halt_reason(config, s),
    })),
    finish: (s, rounds) => project_result(s, rounds),
    max_rounds: config.max_iterations,
  });

  try {
    const { value, converged, rounds } = await run(flow, run_input, {
      trajectory: filesystem_logger({ output_path: volley_path(config, 'trajectory.jsonl') }),
      // run() installs SIGINT/SIGTERM handlers; aborted_error maps to exit 130
    });
    return finalize(value, converged, rounds);
  } finally {
    await engine.dispose();      // SIGTERM -> SIGKILL escalation for stuck subprocesses
  }
}
```

Design notes:

- `body` is a `sequence` of plain `step`s over the carry-state; each step is a thin async function, unit-testable without the engine (the engine is a parameter, mockable behind volley's own `Engine`-shaped seam).
- The guard is where all three stopping conditions live: acceptance, cost cap, and (implicitly, via `max_rounds`) iteration budget. `loop` floors `max_rounds` at 1 and returns `{ value, converged, rounds }` — volley maps `converged && halt === null` → exit 0, `!converged` → exit 2, `halt === 'cost_cap'` → exit 7.
- Abort: fascicle checks `ctx.abort` between rounds and before the guard; volley's steps additionally pass `abort: ctx.abort` into each `generate` and the check spawn so SIGINT lands mid-phase, not just between phases.

### Builder invocation

```ts
async function run_builder(engine: Engine, config: VolleyConfig, s: LoopState): Promise<LoopState> {
  const result = await engine.generate({
    provider: 'claude_cli',
    model: config.builder_model,
    system: compose_builder_system(),
    prompt: compose_builder_prompt({
      task: config.prompt,
      criteria: config.criteria,
      feedback: s.feedback,          // null on iteration 1
      iteration: s.iteration,
    }),
    abort: s.ctx.abort,
    trajectory: s.ctx.trajectory,    // run-decorated logger: run_id/ts/spans stamped
    on_chunk: renderer.builder_chunk,
    provider_options: {
      claude_cli: {
        allowed_tools: ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Grep', 'Glob', 'WebFetch'],
        extra_args: ['--permission-mode', config.builder_permission_mode],
      },
    },
  });
  return accumulate(s, { role: 'builder', result });
  // result.usage: UsageTotals; result.cost?: CostBreakdown;
  // result.provider_reported.claude_cli: { session_id, duration_ms }
}
```

One `generate` call is one complete agentic session: the CLI plans, edits, runs commands, and returns. fascicle enforces this shape — passing multi-turn message history to `claude_cli` throws (`multi_turn_history`); continuation is only via `session_id`/`--resume`, which volley deliberately does not use across iterations (fresh context per iteration). `max_steps`, `tool_error_policy`, and `on_tool_approval` are ignored by this provider (each logs an `option_ignored` trajectory event) — the CLI owns its own step budget.

Workspace skills and settings: the CLI discovers `.claude/skills/`, `.claude/settings.json`, and `.mcp.json` in the workspace via `setting_sources: ['project', 'local']`. volley manages none of this.

### Critic invocation

```ts
const verdict_schema = z.object({
  verdict: z.enum(['approved', 'changes_requested']),
  feedback: z.string().describe(
    'Free-form markdown for the builder. Concrete and actionable. ' +
    'Will be passed verbatim into the next iteration.'),
  unmet_criteria: z.array(z.string()).describe(
    'The specific acceptance criteria judged unmet, verbatim. Empty when approved.'),
});

async function run_critic(engine: Engine, config: VolleyConfig, s: LoopState): Promise<LoopState> {
  const result = await engine.generate({
    provider: 'claude_cli',
    model: config.critic_model,
    system: resolve_critic_prompt(config.critic),     // preset .md + harness append
    prompt: compose_critic_prompt({
      criteria: config.criteria,
      iteration: s.iteration,
      check: s.check,                                 // structured summary + failing-slot JSON
    }),
    schema: verdict_schema,                           // -> --json-schema, validated + repaired
    abort: s.ctx.abort,
    trajectory: s.ctx.trajectory,
    on_chunk: renderer.critic_chunk,
    provider_options: {
      claude_cli: {
        allowed_tools: ['Read', 'Grep', 'Glob'],
        extra_args: ['--disallowedTools', 'Write,Edit,MultiEdit,NotebookEdit,Bash'],
      },
    },
  });
  return accumulate(s, {
    role: 'critic',
    result,
    verdict: result.content.verdict,
    feedback: result.content.feedback,
  });
}
```

Schema failures are retried by fascicle (`schema_repair_attempts`, engine default) before surfacing as an error; a persistent failure is a critic error (exit 6). This replaces v1's open question about "critic retry on invalid verdict" — the retry now exists, at the right layer, for free.

### Critic prompt templates

Three built-in presets, each a short system prompt shipped as a markdown file. Unchanged in spirit from v1.

**reviewer** (default)

```
You are a code reviewer. A builder agent has iterated on a workspace to satisfy
a task and acceptance criteria. Your job is to determine whether the acceptance
criteria are fully met.

Evaluate rigorously. If any criterion is partially met, ambiguous, or fragile,
treat it as unmet and provide concrete, actionable feedback.

Inspect the workspace using Read, Grep, and Glob to verify claims. Do not take
the builder's word for anything; verify against the actual files.
```

**optimizer**

```
You are a code quality optimizer. A builder agent has produced a working
implementation; your job is to identify improvements beyond the baseline
acceptance criteria. Focus on: performance, clarity, error handling,
consistency, and reducing unnecessary complexity.

Approve only when the implementation is not just correct but also clean and
free of obvious improvements. Be willing to approve when further iteration
would yield diminishing returns.
```

**researcher**

```
You are a research reviewer. A builder agent has iterated on a workspace
containing research artifacts (documents, summaries, code experiments, etc.)
toward a research goal.

Evaluate whether the research goal has been adequately covered: key questions
answered, relevant sources consulted, gaps identified. Approve when coverage
is sufficient for the stated goal, even if further depth is always possible.
```

### Harness-appended critic instructions

Appended to all critic system prompts (rewritten from v1 — no more file-writing protocol):

```
You are running inside the volley harness. The workspace is at the current
working directory. Prior iteration state is visible in .volley/iterations/.

You have read-only access to the workspace (Read, Grep, Glob). Do not attempt
to modify files or run commands; those tools are not available to you.

If deterministic check results are included in your prompt, weigh them as
ground truth for what they measure, but remember they are exit-code based —
inspect the raw per-tool output for findings a passing exit code may hide.

When you have finished your review, respond with your structured verdict:
- verdict: "approved" only if every acceptance criterion is met.
- feedback: free-form markdown for the builder. Structure it however is
  clearest. The builder will read it verbatim in the next iteration.
- unmet_criteria: the specific criteria you judged unmet, verbatim.
```

### Builder prompt composition

```
TASK
----
<config.prompt>

ACCEPTANCE CRITERIA
-------------------
<config.criteria>

ITERATION: <n>
<if iteration > 1>
PREVIOUS CRITIC FEEDBACK
------------------------
<state.feedback>

Address the feedback above. The workspace already contains your prior work;
read the current state, then make the necessary changes.
</if>
<if check is checkride>
The definition of done for this workspace includes `pnpm check` (checkride)
exiting 0. Run it yourself before finishing; on failure, read
.check/summary.json, then the failing slot's raw output, fix, and re-run.
</if>
```

The checkride stanza mirrors the guidance checkride's own `init` writes into AGENTS.md — the builder is told to self-verify with the same gate the harness will apply, which shortens the loop (an iteration that would fail the check gets fixed inside the builder session instead of consuming a critic round-trip).

### Check execution

Two runners behind one interface:

**checkride runner** (when `--check auto` resolves to checkride, or the user passes a command recognized as checkride):

```ts
async function run_checkride(opts: CheckOpts): Promise<CheckResult> {
  // pnpm exec checkride --json   (stdout: summary JSON; stderr: suppressed progress)
  const proc = await spawn_capture('pnpm', ['exec', 'checkride', '--json'], {
    cwd: opts.workspace, abort: opts.abort,
  });
  if (proc.exit_code === 2) throw check_harness_error(proc.stderr);   // -> exit 4

  const summary = parse_summary(proc.stdout);   // { schema_version: 1, ok, checks: [...] }
  const failing = summary.checks.filter((c) => !c.ok);
  return {
    ran: true, runner: 'checkride',
    ok: summary.ok, exit_code: proc.exit_code,
    duration_ms: summary.total_duration_ms,
    failing_slots: failing.map((c) => c.name),
    // For the critic prompt: per failing slot, the raw artifact
    // (.check/<output_file> when present, else .check/<slot>.stdout.txt),
    // truncated per-slot with a pointer to the archived file.
    detail: read_failing_artifacts(opts.workspace, failing),
  };
}
```

The `.check/summary.json` contract is checkride's declared public API (`schema_version: 1`; per-check `name`, `adapter`, `ok`, `skipped?`, `exit_code`, `duration_ms`, `output_file`). volley archives the summary plus failing-slot artifacts into `.volley/iterations/NNN/check/` and hands the same material to the critic — the critic reads *what the tool actually said*, not a normalized digest, which is the entire checkride philosophy.

Known caveat, inherited knowingly: checkride's per-slot pass/fail is exit-code based, and two blessed adapters have JSON-mode exit-code quirks as of v0.1.6 (`fallow --format json` exits 0 even with findings — a silent false-green on the `dead` slot; `pnpm audit --json` ignores `--audit-level` — false-fails on moderate vulns). volley does not try to outsmart this: the mitigation is that the critic receives the raw slot JSON and is explicitly instructed (harness append, above) that exit codes can hide findings. Operators can also override slots in `checkride.config.json`.

**command runner** (any other `--check` string): unchanged from v1 — `sh -c`, stdout+stderr captured to `check.log`, exit code to `check.exit`, `ok = exit_code === 0`. Command-not-found is exit 4.

`--check none` (or `auto` with nothing detected): `check = { ran: false, ok: true }`; the loop is critic-gated only.

### Live output streaming

Every phase streams to two sinks:

1. **Persistent**: the run-level trajectory. fascicle's decorated logger stamps `run_id`, `ts`, and span ids on every event; the engine emits `request_sent`, `response_received`, `tool_call`, `tool_result`, `cost`, and claude_cli-specific events (`cli_rate_limit_event`, …). Written via `filesystem_logger` to `.volley/trajectory.jsonl` (synchronous appends — acceptable for a single-loop CLI per fascicle's documented adapter limits).
2. **Display**: the renderer, fed by each `generate`'s `on_chunk` callback with typed `StreamChunk`s, plus volley's own phase/cost lines.

Display format (glyph taxonomy carried over from v1):

| Glyph | Event |
|---|---|
| `💬` | `text` chunks (model prose) |
| `💭` | `reasoning` chunks (dimmed; hidden with `--no-thinking`) |
| `🔧` | `tool_call_start` (name + one-line input summary) |
| `✅` / `❌` | `tool_result` (ok / error) |
| `💰` | Cost update (per `step_finish` / phase end) |
| `▶` `✓` `✗` | Phase start / end-success / end-failure |

Color mapping: builder cyan, critic yellow, check green/red, cost magenta, errors bold red. Colors disabled if stderr is not a TTY, or `VOLLEY_NO_COLOR`/`NO_COLOR` is set. All human output goes to **stderr** (see §5 stream conventions).

Verbosity: **default** streams text/reasoning in full and summarizes tool calls/results to one line; **`--verbose`** prints tool inputs/outputs up to 4000 chars; **`--quiet`** shows only phase transitions, cost lines, and the final summary; **`--json`** suppresses all streaming and emits the summary JSON on stdout.

Implementation caveat (verified against fascicle 0.8.12): if volley ever renders from `run.stream(...).events` instead of `on_chunk`, note that model chunks arrive as `kind: 'emit'` events carrying an `event.chunk` payload — the runner rewrites the `model_chunk` kind that some fascicle docs still reference. `on_chunk` sidesteps the issue and is the specified path.

### Cost tracking

All bespoke v1 machinery (pricing table, `compute_cost`, staleness CI check, `VOLLEY_PRICING_PATH` schema) is deleted. What remains in volley:

- **Accumulation**: after each `generate`, fold `result.usage` and `result.cost?.total_usd` into loop state, per role and run-wide. When `cost` is `undefined` (unknown pricing on a non-reporting provider), record `null` and warn once — never fail the run over pricing.
- **Cap enforcement**: the loop guard compares the running total against `--max-cost-usd` after each completed iteration; the check step also short-circuits to the guard if the builder alone crossed the cap (so a cap crossing skips the critic spend when the iteration can no longer succeed within budget). Sessions are never aborted mid-flight for cost — a deliberate v1 tradeoff that stands: killing a builder mid-edit leaves the workspace undefined, which is worse than a one-phase overshoot. Operators should set the cap below their true ceiling by roughly one iteration's expected cost.
- **Live display**: `[iter 2] [builder] 💰 phase: $0.218 | run: $0.591 / $20.00` after each phase (and per `step_finish` chunk when the provider reports incremental usage).
- **Overrides**: pricing overrides go to fascicle — `EngineConfig.pricing` rows keyed `"<provider>:<model_id>"` (e.g. `"claude_cli:opus"`), loaded from the JSON file named by `VOLLEY_PRICING_PATH` if set. For `claude_cli` this is rarely needed: the CLI reports authoritative `total_cost_usd` (`provider_reported`).

## §7 — Constraints

### Technical constraints

- Language: TypeScript, strict mode. `tsconfig.json` extends `@tsconfig/node24`.
- Runtime: Node.js ≥ 24 (fascicle's floor; also satisfies checkride's ≥ 22.18). ESM-only (`"type": "module"`). pnpm ≥ 10.
- Style: Functional and procedural. No classes. No `this`. `snake_case` for variables, functions, parameters, and filenames; `PascalCase` for types; `SCREAMING_SNAKE_CASE` for module-level constants. (This matches fascicle's own house style, so volley code and its substrate read as one system.)
- Error handling: Return unions for recoverable domain errors; throw for programmer errors and let fascicle's error taxonomy (`aborted_error`, `provider_capability_error`, schema errors) propagate to the top-level handler that maps errors to exit codes.
- Composition: the loop, its steps, and cancellation go through fascicle (`loop`, `step`, `sequence`, `run`). volley must not hand-roll a competing runner.
- Engine access: `create_engine` is called in exactly one module (`src/engine.ts`); every other module receives an `Engine`-shaped value. This keeps the engine mockable and is the v2 restatement of v1's "orchestrator does not import the Agent SDK directly".
- No ORM, no database. All state in filesystem.
- Testing: Vitest. Unit tests for pure functions (prompt composition, config parsing, verdict schema, checkride summary parsing, guard logic). Integration tests run the CLI against fixture workspaces with a mock engine.
- Verification: volley's own repo is checked by **checkride** (`pnpm check` = `checkride`), dogfooding the same definition-of-done it offers its users. Lint slot: oxlint (checkride's blessed default).

### Scope constraints (explicit non-goals for v2)

- Anthropic-only **by policy, not by construction**: v2 wires only the `claude_cli` provider. The fascicle engine seam means a future multi-provider volley (builder on API providers with worktree-scoped tools, as fascicle's pr-improve example demonstrates) is a config surface, not a rewrite — but it is out of scope now.
- No parallel iterations or multi-builder fan-out.
- No plan phase. The builder plans internally. If you need explicit plan/build/evaluate phases, use ridgeline.
- No resumption from mid-phase failures. Resumption only from completed iterations.
- No web UI or dashboard (`fascicle-viewer` can already replay `.volley/trajectory.jsonl`; that is sufficient).
- No distributed execution.
- No automatic skill installation; skills are user-provided via `.claude/skills/`.
- No MCP server management; the workspace's `.mcp.json`/settings are discovered by the CLI itself.
- No critic memory across runs.
- No auto-escalation of models between iterations.
- volley does not install or configure checkride in the target workspace (`checkride init` is the user's move); volley only detects and runs it.

### Operational constraints

- Designed for local developer machines. No cloud-deployment assumptions.
- Workspace on a local filesystem.
- `claude` binary on PATH (or `VOLLEY_CLAUDE_BIN`); `git` on PATH if `--git`; `pnpm` on PATH if checkride is the check runner (checkride shells out via `pnpm exec`).
- Single-process execution; the only children are the CLI subprocess (managed by fascicle, with startup/stall timeouts and SIGTERM→SIGKILL escalation on dispose) and the check command.

## §8 — Dependencies

### Runtime dependencies

| Package | Purpose |
|---|---|
| `fascicle` (^0.8.12) | Loop composition, engine + `claude_cli` provider, usage/cost, trajectory logging, cancellation, `filesystem_logger`. |
| `zod` (^4) | Verdict schema, config validation. Required peer of fascicle. |
| `ai` (^6) | Required peer of fascicle (transitive; volley does not import it directly). |
| `cac` | CLI argument parsing. |
| `picocolors` | Terminal color output. |

Dropped from v1: `@anthropic-ai/claude-agent-sdk` (replaced by fascicle's `claude_cli` provider), `execa` (fascicle manages the agent subprocess; the check spawn is a plain `child_process` wrapper), `commander` (settled on `cac`).

Not a dependency: **checkride**. It belongs to the target workspace as a devDependency (`pnpm check` resolves the workspace's own pinned version); volley only spawns it. checkride *is* a devDependency of volley's own repo, for volley's own checks.

### Development dependencies

| Package | Purpose |
|---|---|
| `vitest` | Test runner. |
| `typescript` | Compiler. |
| `@types/node`, `@tsconfig/node24` | Node types and base tsconfig. |
| `tsx` / `tsup` | Dev runner / publish bundler. |
| `checkride` | volley's own verification pipeline (`pnpm check`). |

### Infrastructure dependencies

- Node.js ≥ 24 on the host; pnpm.
- Claude Code CLI (`claude`) installed and authenticated (subscription login or API key).
- `git` binary on PATH if `--git` is used.
- For checkride-checked workspaces: the workspace's own pinned tools (`tsc`, `oxlint`, `vitest`, …) installed via pnpm.

## §9 — Failure Modes

| # | Scenario | Expected behavior | Verification |
|---|---|---|---|
| 1 | Workspace does not exist | Exit 5, `workspace not found: <path>`. | Run against `/nonexistent`, verify exit 5. |
| 2 | Workspace not writable | Exit 5, `workspace not writable`. | Read-only dir, verify exit 5. |
| 3 | `--git` set but workspace is not a git repo | Exit 5. | Non-git dir with `--git`, verify exit 5. |
| 4 | `ANTHROPIC_API_KEY` set | Warning at run start naming which meter will be billed. Run continues. | Set env var, verify stderr warning. |
| 5 | `claude` binary not found / CLI startup exceeds 120 s / stream stalls > 300 s | fascicle throws the corresponding provider error; volley maps to exit 3 with the phase and iteration named. Partial trajectory preserved. | Point `VOLLEY_CLAUDE_BIN` at a bogus path; verify exit 3 and message. |
| 6 | Builder session errors mid-run | Exit 3. Iteration state preserved (trajectory has all events up to failure). | Mock engine throwing on `generate`; verify exit 3 + trajectory. |
| 7 | Critic returns output that fails the verdict schema after repair attempts | Exit 6, `critic failed to produce a valid verdict: <zod issue summary>`. | Mock engine returning malformed content past repair; verify exit 6. |
| 8 | Critic attempts a write tool | Denied at the CLI permission layer (`--disallowedTools` + headless auto-deny); session continues; the verdict still arrives as structured output. Not a run failure. | Fixture critic prompt that tries to Edit; verify denial event in trajectory and a valid verdict. |
| 9 | Check command not found (custom runner) | Exit 4, `check command failed to start`. | `--check nonexistent_bin`, verify exit 4. |
| 10 | checkride exits 2 (config/usage error) | Exit 4 — a broken pipeline is not iterable. stderr includes checkride's own error text. | Corrupt `checkride.config.json`, verify exit 4. |
| 11 | checkride exits 1 (checks failed) | Not a failure: `check.ok = false`, failing-slot artifacts fed to the critic, loop continues. | Fixture with a failing test; verify loop iterates and critic feedback names the slot. |
| 12 | checkride false-green (e.g. `fallow --format json` exit-code quirk) | Tolerated at the gate; mitigated by handing raw slot JSON to the critic with the "exit codes can hide findings" instruction. | Fixture with dead code + passing exit; verify critic feedback can still flag it. |
| 13 | `pnpm` missing in a checkride workspace | Exit 4 at first check (spawn failure). `--dry-run` catches it earlier via `checkride doctor`. | PATH without pnpm, verify both paths. |
| 14 | Max iterations reached without success | Exit 2. `loop` returns `converged: false`; stderr: `max iterations reached (<n>); last verdict: <v>, last check: <ok\|failed>`. | `--max-iterations 1` on an impossible task. |
| 15 | SIGINT during a phase | Exit 130. fascicle's signal handler aborts the run; `generate` and the check spawn observe the signal; cleanup (engine dispose, log close) runs LIFO; iteration dir left as-is; resumable. | SIGINT mid-build; verify exit 130, valid trajectory jsonl, `resume` continues. |
| 16 | Second SIGINT within 3 s | Force-terminate immediately (fascicle escalates the subprocess SIGTERM→SIGKILL on dispose). | Double SIGINT, verify prompt exit. |
| 17 | Stale `.volley/` from a previous run | On fresh run (not `resume`), rename to `.volley.bak.<timestamp>/` and start clean. | Run twice, verify backup exists. |
| 18 | Cost cap reached | Exit 7. Guard stops the loop after the current iteration (or skips the critic when the builder alone crossed it). `status: "cost_cap_reached"`. | `--max-cost-usd 0.01`, verify exit 7 without a mid-session abort. |
| 19 | Cost unavailable (unknown model on a non-reporting path) | `cost_usd: null` for that phase, single warning, run continues; run totals sum what is known. | Mock result without `cost`; verify summary shape. |
| 20 | Verdict semantics | No trailing-whitespace/empty-file/invalid-value cases exist: the verdict is schema-validated in-band and the harness writes the files. | Covered by #7. |

## §10 — Success Criteria

### Automated tests (unit)

- **config_parsing**: CLI arg vector → expected `VolleyConfig`. All flags, `@file` expansion, defaults, validation errors, `--check auto|none|command` resolution.
- **check_detection**: workspace fixtures with/without `checkride.config.json`, `scripts.check`, `.bin/checkride` → correct runner resolution.
- **checkride_summary_parsing**: fixture `summary.json` documents (pass, fail, skipped slots, `exit_code: -1` timeout entries, unknown extra fields) → correct `CheckResult`; schema_version ≠ 1 → warning, best-effort parse.
- **verdict_schema**: valid verdicts, invalid enum values, missing fields → zod accept/reject as specified.
- **builder_prompt_composition**: first iteration (no feedback), later iterations (feedback embedded), checkride stanza present only when checkride is the runner. Fixture-matched.
- **guard_logic**: table-driven over `(check.ok, verdict, cost, cap)` → `{stop, halt}` as specified.
- **cost_accumulation**: sequences of `GenerateResult`s (with cost, without cost, mixed sources) → correct per-role and run totals, `null` handling.
- **renderer**: fixture `StreamChunk` sequences per verbosity level → expected stderr lines; `--json` produces exactly one stdout document.
- **exit_code_mapping**: error taxonomy (provider errors, schema errors, aborted_error, check errors) → specified exit codes.

### Automated tests (integration)

All integration tests inject a mock `Engine` (scripted `generate` results + chunks) except the two marked live.

- **fresh_workspace_happy_path**: trivial prompt, mock builder writes the file, mock critic approves, custom check command passes → exit 0, `.volley/` layout complete, summary totals non-zero.
- **checkride_gate_loop**: fixture pnpm workspace with checkride and a deliberately failing test; iteration 1 fails the check, critic feedback names the failing slot, mock builder "fixes" it, iteration 2 passes → exit 0; `iterations/001/check/` contains the archived summary + failing artifact.
- **budget_exhaustion**: critic never approves → exit 2 after `--max-iterations`.
- **cost_cap**: scripted costs crossing the cap → exit 7, no critic call after the builder crossed it.
- **critic_readonly**: trajectory from a critic session shows denied write attempts and a valid structured verdict (mock CLI event stream).
- **resume**: kill after iteration 2, `volley resume` continues at 3 with feedback and cost totals carried. 
- **sigint_graceful**: SIGINT mid-build → exit 130, `trajectory.jsonl` is valid line-delimited JSON with no torn tail, resume works.
- **live_smoke** (opt-in, env-gated): one-iteration run against the real `claude` CLI on a trivial task — verifies argv wiring, schema output, and cost reporting end to end. Mirrors fascicle's own opt-in live-provider tests.
- **live_checkride_smoke** (opt-in): real checkride in a minimal fixture workspace, `--json` parse verified against `schema_version: 1`.

### Architectural validation

- No class declarations in `src/`; no `this`.
- `create_engine` appears in exactly one file (`src/engine.ts`); no other module imports it or any provider SDK.
- No pricing table, token math, or `per_mtok`/`per_million` constants anywhere in `src/` — grep returns zero. Cost knowledge lives in fascicle.
- The loop is fascicle's `loop`; grep for `while` / `for (` in `src/orchestrator.ts` returns zero iteration constructs.
- `src/critic/presets/` contains one markdown file per preset; presets discoverable by listing the directory.
- `pnpm check` (checkride) passes on volley's own repo.

### Learning outcomes

- Validate the **structured-verdict critic** against v1's file-drop design: does schema-constrained output eliminate the verdict failure class in practice, and does `schema_repair_attempts` ever mask a critic that should have failed loudly?
- Measure how much harness the substrate absorbed: LOC of volley v2 vs the v1 file structure, and whether anything in §11 still smells like plumbing fascicle should own (candidate feedback upstream).
- Confirm fresh-context-per-iteration scales to ~20 iterations without quality degradation vs `session_id` continuation (now trivially testable by flipping one option).
- Surface whether the three-preset taxonomy (reviewer, optimizer, researcher) covers real use cases or collapses into "reviewer with different words".
- Evaluate checkride-as-gate: how often the critic catches what the exit code missed (the false-green mitigation earning its keep), and whether the builder's self-run `pnpm check` measurably reduces iteration count.

## §11 — File Structure

```
volley/
  package.json                    # ESM, node>=24, pnpm
  tsconfig.json                   # extends @tsconfig/node24
  checkride.config.json           # volley's own check pipeline
  README.md
  src/
    cli.ts                        # entry point, cac argv parsing, dispatch, exit-code mapping
    config.ts                     # VolleyConfig type, resolution, validation, @file expansion
    orchestrator.ts               # composes loop({init, body, guard, finish}), calls run()
    engine.ts                     # the ONLY create_engine call; per-run claude_cli engine
    workspace.ts                  # init, .bak rotation, path helpers
    iteration.ts                  # archive_iteration, per-iteration + run summaries
    builder.ts                    # run_builder step + prompt composition
    critic/
      run.ts                      # run_critic step, verdict_schema
      prompt.ts                   # compose_critic_prompt, resolve_critic_prompt
      presets/
        reviewer.md
        optimizer.md
        researcher.md
        harness_append.md
    check/
      detect.ts                   # --check auto resolution
      checkride.ts                # spawn + summary.json parse + artifact collection
      command.ts                  # generic sh -c runner (v1 semantics)
    render/
      renderer.ts                 # on_chunk consumers per verbosity, phase/cost lines
      format.ts                   # glyphs, colors, truncation
    cost.ts                       # accumulate usage/cost into state, cap predicate
    types.ts                      # LoopState, RunResult, CheckResult, VolleyConfig
    exit_codes.ts
  test/
    unit/                         # per §10
    integration/                  # per §10, mock engine in test/helpers/
    fixtures/
      trivial_math/
      checkride_workspace/        # minimal pnpm + checkride fixture
      impossible/
  examples/
    reviewer/  optimizer/  researcher/
```

Gone from v1: `src/agent/` (SDK wrapper — now fascicle), `src/cost/` (three files → one), `src/stream/` renderer rewritten against `StreamChunk`, `src/verdict.ts` (file parsing → zod schema), `src/git.ts` folds into `workspace.ts`.

## §12 — Environment Variables

| Name | Required | Purpose | Example |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | no | Forwarded to the CLI subprocess when `auth_mode` is `api_key`/`auto`. Triggers the billing-meter warning. | `sk-ant-api03-...` |
| `VOLLEY_CLAUDE_BIN` | no | Path to the `claude` binary (maps to `claude_cli.binary`). Default `claude` on PATH. | `/opt/claude/bin/claude` |
| `VOLLEY_AUTH_MODE` | no | `auto` \| `oauth` \| `api_key` (maps to `claude_cli.auth_mode`). Default `auto`. | `oauth` |
| `VOLLEY_LOG_LEVEL` | no | Harness logging verbosity: `error`, `warn`, `info`, `debug`. Default `info`. | `debug` |
| `VOLLEY_NO_COLOR` | no | Disable colored output. Also respects standard `NO_COLOR`. | `1` |
| `VOLLEY_PRICING_PATH` | no | JSON file of fascicle `Pricing` rows keyed `"<provider>:<model_id>"`, merged into the engine's table. Rarely needed for claude_cli (CLI-reported cost). | `./custom-pricing.json` |

Dropped from v1: `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` (gateway routing was an Agent SDK concern; the CLI subprocess has its own configuration surface), `VOLLEY_NO_STREAM` (use `--quiet`/`--json`).

Ship a `.env.example` at repo root with commented entries for all of the above.

## §13 — Open Questions

1. **`adversarial` convergence.** volley uses `loop` for the reasons in §2. If fascicle's `adversarial` ever grows a richer accept signature (access to loop state / a halt-reason channel), volley's body collapses into it almost mechanically. Watch upstream; candidate feedback to file.

2. **Stop-hook double-run.** When the builder self-runs `pnpm check` (per the prompt stanza) and volley then runs it again as the gate, the pipeline executes twice per iteration. checkride's own docs describe the fix: verify the artifact instead of recomputing — accept a complete, green `.check/summary.json` newer than the workspace's sources and only re-run when missing or stale. Deferred pending measurement of real check durations; `--changed`/`--bail` narrowing may make it moot.

3. **Multi-provider roles.** fascicle's pr-improve example proves the pattern: API-provider builders with worktree-scoped `execute` tools, `claude_cli` builders with CLI built-ins, one flow. A cheap critic (e.g. a local model via `ollama`) is the most tempting first step since the critic is read-only + schema. Deferred; requires designing the read-only tool set for non-CLI critics.

4. **Sandboxed builder.** fascicle's `claude_cli` provider has a `sandbox` config (`bwrap` / `greywall`, network allowlist, additional write paths). Wiring `--sandbox` through would harden untrusted-prompt runs considerably for one config field. Near-term candidate — smaller lift than v1's worktree idea, which it supersedes.

5. **Mid-session cost abort.** Unchanged from v1: the cap is checked between phases; a runaway builder session can overshoot. `generate` accepts an `abort` signal, so a cost-watching abort is now *possible* (trajectory `cost` events arrive mid-session) — but killing a builder mid-edit still leaves the workspace undefined. Deferred; revisit if overshoots bite in practice.

6. **volley as a child agent.** fascicle v0.8.11's `run_stdio` defines a single-shot stdio contract (stdin JSON → stdout result JSON, stderr trajectory, exit 0/1/2). A `volley --stdio` mode implementing the same contract would let bigger harnesses (or ridgeline) embed a volley loop as one step. The `--json` stdout hygiene in §5 is the first half of this; deferred until a real parent harness wants it.

7. **Trajectory viewer.** `fascicle-viewer` ships with the substrate and reads the same jsonl volley writes. Verify `.volley/trajectory.jsonl` replays cleanly in it and document that instead of building anything (v1 open question 10, mostly dissolved).

8. **Interactive approval mode.** Pause after each critic for human approve/override. Unchanged from v1: deferred; primary use case is unattended runs. fascicle's `suspend`/`resume_data` + `checkpoint_store` is the natural implementation when wanted.

9. **Resume with modified config.** Unchanged from v1: `volley resume` reuses the original config; workaround is editing `.volley/config.json`. Deferred.

10. **Verdict schema evolution.** `unmet_criteria` is the first structured field beyond verdict+feedback. Candidates: per-criterion pass/fail map, confidence, `checked_files`. Resist until a consumer exists — the builder currently reads only `feedback`, verbatim, and that simplicity is load-bearing.
