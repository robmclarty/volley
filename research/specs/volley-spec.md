# volley — Specification

A CLI harness that runs a builder/critic loop until a task passes both a deterministic check command and a natural-language acceptance review.

---

## §1 — Problem Statement

Complex agentic coding tasks benefit from iteration: a first pass rarely hits every constraint, and a reviewing pass catches mistakes, gaps, and missed acceptance criteria that the builder missed under its own attention budget. Today, this iteration is either manual (human running Claude Code, reading output, pasting feedback, running again) or embedded in bespoke harnesses like ridgeline that hardcode a plan/build/evaluate sequence for a specific job shape.

The user wants a minimal, general-purpose loop harness: prompt in, build, review, repeat until reviewer and check both pass. The builder is an agent given autonomy over a workspace. The critic is pluggable. Swapping the critic role changes what the loop does: a reviewer drives the loop toward an acceptance target, an optimizer drives it toward improvement plateau, a researcher drives it toward coverage completeness. Same harness, different objective function.

The secondary goal is architectural clarity. volley is deliberately a sibling to ridgeline, not a replacement. ridgeline fixes plan/build/evaluate as three phases with strong context boundaries between them. volley collapses plan into the builder's own autonomy and makes evaluation fully pluggable. Where ridgeline is opinionated about phase structure, volley is opinionated about role separation and nothing else.

## §2 — Solution Overview

volley is a TypeScript CLI that wraps the Claude Agent SDK. It runs a two-role loop until a stopping condition is met.

### Roles

**Builder**: An Agent SDK session with full tool access in a designated workspace directory. Receives the task prompt, the acceptance criteria, and optionally feedback from the previous iteration's critic. Modifies the workspace autonomously.

**Critic**: An Agent SDK session with read-only tool access to the workspace, plus permission to write exactly two files under `.volley/`: `feedback.md` (free-form markdown) and `verdict` (one of `approved` or `changes_requested`). Evaluates the workspace against acceptance criteria and, if applicable, check command output.

### Loop shape

```
initialize workspace (.volley/ dir, optional git init)
iteration = 1
loop:
  run builder(prompt, criteria, feedback=if iteration > 1 then previous feedback else null)
  archive builder messages to .volley/iterations/NNN/
  if check command provided:
    run check, capture output to .volley/iterations/NNN/check.log
    check_passed = (exit_code == 0)
  else:
    check_passed = true
  run critic(criteria, iteration, check output, workspace access)
  critic writes .volley/feedback.md and .volley/verdict
  archive critic messages and feedback+verdict to .volley/iterations/NNN/
  if check_passed and verdict == approved:
    return success
  if iteration == max_iterations:
    return budget_exhausted
  iteration += 1
```

### Architecture diagram

```
                   ┌──────────────────┐
   CLI invocation  │   volley loop    │
  ───────────────> │   orchestrator   │
                   └────────┬─────────┘
                            │
          ┌─────────────────┼─────────────────┐
          ▼                 ▼                 ▼
   ┌──────────────┐  ┌─────────────┐  ┌──────────────┐
   │   builder    │  │    check    │  │    critic    │
   │ (Agent SDK,  │  │  (optional  │  │ (Agent SDK,  │
   │ full tools,  │  │ user-defined│  │  read-only + │
   │ cwd=workspace)│ │  CLI command)│  │ two writable │
   │              │  │              │  │ signal files)│
   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
          │                 │                 │
          ▼                 ▼                 ▼
   ┌─────────────────────────────────────────────────┐
   │                  workspace                      │
   │  <project files>                                │
   │  .volley/                                       │
   │    feedback.md       ← critic writes            │
   │    verdict           ← critic writes            │
   │    iterations/NNN/   ← orchestrator archives    │
   │    config.json       ← resolved run config      │
   └─────────────────────────────────────────────────┘
```

Fresh context is strict: each builder invocation and each critic invocation starts a new Agent SDK session. State flows between iterations exclusively through the workspace filesystem (source files, `.volley/feedback.md`, `.volley/iterations/`). This is the same context-hygiene discipline ridgeline enforces. It makes each iteration independently reproducible and debuggable.

### Live monitoring

Long-running autonomous loops need an active observation channel. Two features support this:

**Streaming output.** Agent SDK messages (assistant text, thinking, tool calls, tool results) are rendered to the terminal as they arrive from the model. The operator can read along, verify the agent is doing sensible work, and interrupt with SIGINT if it is not. Message logs continue to be written to jsonl in parallel, so streaming is a display concern, not a storage concern.

**Cost and token tracking.** Token counts and estimated USD cost are aggregated per-iteration and run-wide. Live counters update after each assistant message. A hard cost ceiling (`--max-cost-usd`) halts the loop if crossed. A per-iteration summary and a run-level summary are persisted as JSON.

## §3 — Filesystem Data Model

volley is not a database-backed system; its persistent state is a directory layout inside the user's workspace.

### Workspace layout during a run

```
<workspace>/
  <user's project files>            # whatever the builder works on
  .claude/                          # optional, user-provided
    skills/                         # discovered by Agent SDK
      <skill-name>/
        SKILL.md
  .volley/
    config.json                     # resolved run config (see below)
    summary.json                    # run-level aggregated usage and cost
    feedback.md                     # current iteration's feedback (critic writes)
    verdict                         # "approved" | "changes_requested" (critic writes)
    iterations/
      001/
        feedback.md                 # archived copy
        verdict                     # archived copy
        check.log                   # check command stdout+stderr, if check ran
        check.exit                  # check command exit code as integer string
        builder.messages.jsonl      # every Agent SDK message from builder
        critic.messages.jsonl       # every Agent SDK message from critic
        summary.json                # per-iteration timing, usage, cost, verdict
      002/
        ...
```

### .volley/iterations/NNN/summary.json

Written when an iteration completes (builder + check + critic all done). Shape:

```json
{
  "iteration": 1,
  "started_at": "<iso8601>",
  "completed_at": "<iso8601>",
  "duration_ms": 45231,
  "builder": {
    "model": "claude-opus-4-7",
    "duration_ms": 28500,
    "num_turns": 12,
    "usage": {
      "input_tokens": 15234,
      "output_tokens": 2103,
      "cache_creation_input_tokens": 8500,
      "cache_read_input_tokens": 42100
    },
    "cost_usd": 0.287,
    "cost_source": "sdk_reported"
  },
  "check": {
    "ran": true,
    "passed": true,
    "exit_code": 0,
    "duration_ms": 2300
  },
  "critic": {
    "model": "claude-opus-4-7",
    "duration_ms": 14431,
    "num_turns": 5,
    "usage": { "...": "..." },
    "cost_usd": 0.091,
    "cost_source": "sdk_reported"
  },
  "verdict": "approved",
  "iteration_cost_usd": 0.378,
  "iteration_total_cost_usd": 0.711
}
```

`cost_source` is `sdk_reported` when the Agent SDK emitted a `result` message with `total_cost_usd`, or `computed` when the harness calculated from token counts against the pricing table. Prefer SDK-reported when available.

### .volley/summary.json (run-level)

Updated after each completed iteration and finalized at run end. Shape:

```json
{
  "run_id": "<uuid>",
  "status": "running | success | budget_exhausted | cost_cap_reached | interrupted | error",
  "started_at": "<iso8601>",
  "completed_at": "<iso8601| null>",
  "iterations_completed": 3,
  "total_usage": {
    "input_tokens": 52341,
    "output_tokens": 8230,
    "cache_creation_input_tokens": 28100,
    "cache_read_input_tokens": 189400
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
  "version": 1,
  "run_id": "<uuid>",
  "started_at": "<iso8601>",
  "prompt": "<string>",
  "criteria": "<string>",
  "check_command": "<string | null>",
  "builder_model": "claude-opus-4-7",
  "critic_model": "claude-opus-4-7",
  "critic_preset": "reviewer | optimizer | researcher | custom",
  "critic_prompt_path": "<string | null>",
  "max_iterations": 10,
  "git_checkpoints": false,
  "workspace": "<absolute path>"
}
```

### .volley/verdict

A file containing exactly one of two strings (no trailing newline handling is strict; trailing whitespace is tolerated):

- `approved`
- `changes_requested`

Any other value is a critic error (see §9).

### .volley/feedback.md

Free-form markdown. No required structure. The critic writes whatever it thinks the builder needs. The harness does not parse this file; it is passed verbatim to the next builder iteration as context.

## §4 — Authentication and Authorization

volley is a local CLI tool. No authentication layer of its own.

Agent SDK authenticates against Anthropic via whatever mechanism Claude Code is configured with on the host: Max/Pro subscription OAuth, API key in `ANTHROPIC_API_KEY`, or routing through Vercel AI Gateway via `ANTHROPIC_BASE_URL`. volley does not manage these credentials.

If both a Claude subscription and an `ANTHROPIC_API_KEY` are present, Claude Code uses the API key and bills accordingly. volley surfaces a warning at run start if `ANTHROPIC_API_KEY` is set, so users intending to stay on subscription usage are not surprised.

### Critic permission scope

The critic must not modify the workspace outside `.volley/feedback.md` and `.volley/verdict`. This is enforced via Agent SDK's `canUseTool` permission callback:

```ts
const critic_permission: CanUseTool = async (tool_name, input) => {
  if (tool_name === 'Write' || tool_name === 'Edit' || tool_name === 'MultiEdit') {
    const target = resolve_target_path(input);
    const allowed = [
      path.join(workspace, '.volley/feedback.md'),
      path.join(workspace, '.volley/verdict'),
    ];
    if (!allowed.includes(target)) {
      return { behavior: 'deny', message: `critic may only write .volley/feedback.md and .volley/verdict, got ${target}` };
    }
  }
  if (tool_name === 'Bash') {
    // allow read-only bash (grep, find, cat, ls, etc.) but deny writes
    // this is a soft boundary — we cannot perfectly enforce it via string matching
    // so we rely on the system prompt plus this layer as defense in depth
    return { behavior: 'allow' };
  }
  return { behavior: 'allow' };
};
```

Bash commands from the critic are a soft boundary. The critic system prompt explicitly instructs read-only behavior; the permission layer catches direct Write/Edit/MultiEdit attempts. Users concerned about critic bash misbehavior can tighten by running critic in a sandboxed worktree (see §13).

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
  [--check "<shell command>"] \
  [--builder-model <model-id>] \
  [--critic-model <model-id>] \
  [--critic <preset-name or path>] \
  [--max-iterations <n>] \
  [--git] \
  [--skills-dir <path>] \
  [--dry-run]
```

### Options

| Flag | Required | Default | Description |
|---|---|---|---|
| `--prompt` | yes | — | The task prompt. Literal string, or `@path/to/file.md` to read from file. |
| `--workspace` | yes | — | Path to the workspace directory. Must exist. Must be writable. |
| `--criteria` | yes | — | Acceptance criteria as natural language. Literal string or `@path`. |
| `--check` | no | null | Shell command to run after each build. Must exit 0 for done state. Run via `sh -c`. |
| `--builder-model` | no | `claude-opus-4-7` | Anthropic model ID for builder role. |
| `--critic-model` | no | `claude-opus-4-7` | Anthropic model ID for critic role. |
| `--critic` | no | `reviewer` | One of `reviewer`, `optimizer`, `researcher`, or a path to a custom system prompt markdown file. |
| `--max-iterations` | no | 10 | Hard cap on iteration count. |
| `--git` | no | false | Auto-commit after each phase to the workspace git repo. Requires workspace to be a git repo. |
| `--skills-dir` | no | `<workspace>/.claude/skills` | Directory Agent SDK should discover skills from. |
| `--dry-run` | no | false | Validate config and exit without running the loop. |
| `--config` | no | — | Path to a TypeScript config file exporting a `VolleyConfig` object. CLI flags override. |
| `--max-cost-usd` | no | null | Hard USD ceiling. When total estimated cost crosses this, the loop halts after the current phase completes. No cap if unset. |
| `--verbose` | no | false | Show full message content, including tool call inputs and results. |
| `--quiet` | no | false | Suppress message streaming. Show only phase transitions, cost updates, and final summary. |
| `--no-stream` | no | false | Disable live message streaming entirely. Implies logs-only mode. Overrides `--verbose`. |
| `--no-thinking` | no | false | Hide thinking blocks from streamed output. Thinking is still written to jsonl logs. |

### Subcommand: resume

```
volley resume <run-id>
```

Resumes a run from the last completed iteration. Reads `.volley/config.json` to recover settings. Continues from `iteration = last_completed + 1`. If the last iteration was interrupted mid-phase, that iteration is discarded and re-run.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success: check passed and verdict is approved. |
| 2 | Budget exhausted: max iterations reached without success. |
| 3 | Builder error: Agent SDK failure or unrecoverable tool error. |
| 4 | Check command error: command not found or non-numeric exit. |
| 5 | Configuration error: missing required flag, invalid model, workspace not writable, `--git` without repo. |
| 6 | Critic error: invalid verdict value, critic failed to write verdict file. |
| 7 | Cost cap reached: `--max-cost-usd` exceeded. |
| 130 | Interrupted by SIGINT. Partial iteration state is preserved. |

### Config file format

```ts
// volley.config.ts
import type { VolleyConfig } from 'volley';

const config: VolleyConfig = {
  prompt: '...',
  workspace: './my-project',
  criteria: '...',
  check: 'npm test && npm run lint',
  builder_model: 'claude-opus-4-7',
  critic_model: 'claude-opus-4-7',
  critic: 'reviewer',
  max_iterations: 10,
  max_cost_usd: 20.0,
  git_checkpoints: false,
  stream: true,
  verbose: false,
  show_thinking: true,
};

export default config;
```

## §6 — Business Logic

### Loop orchestration

The orchestrator is a single async function. No classes, no framework, just sequenced calls. Pseudocode:

```ts
async function run_volley(config: VolleyConfig): Promise<RunResult> {
  await initialize_workspace(config);
  write_resolved_config(config);

  for (let iteration = 1; iteration <= config.max_iterations; iteration += 1) {
    const iter_dir = prepare_iteration_dir(config.workspace, iteration);

    const previous_feedback = iteration > 1
      ? read_file(path.join(config.workspace, '.volley/feedback.md'))
      : null;

    await run_builder({
      workspace: config.workspace,
      prompt: config.prompt,
      criteria: config.criteria,
      feedback: previous_feedback,
      iteration,
      model: config.builder_model,
      messages_log: path.join(iter_dir, 'builder.messages.jsonl'),
    });

    if (config.git_checkpoints) {
      git_commit(config.workspace, `volley iter ${iteration}: build`);
    }

    const check_result = config.check
      ? await run_check({
          command: config.check,
          cwd: config.workspace,
          log_path: path.join(iter_dir, 'check.log'),
          exit_path: path.join(iter_dir, 'check.exit'),
        })
      : { passed: true, output: null };

    await run_critic({
      workspace: config.workspace,
      criteria: config.criteria,
      iteration,
      check_result,
      model: config.critic_model,
      system_prompt: resolve_critic_prompt(config.critic),
      messages_log: path.join(iter_dir, 'critic.messages.jsonl'),
    });

    const verdict = read_verdict(config.workspace);
    archive_feedback_and_verdict(config.workspace, iter_dir);

    if (config.git_checkpoints) {
      git_commit(config.workspace, `volley iter ${iteration}: critique (${verdict})`);
    }

    write_iteration_summary(iter_dir, { check_result, verdict, iteration });

    if (check_result.passed && verdict === 'approved') {
      return { status: 'success', iterations: iteration };
    }
  }

  return { status: 'budget_exhausted', iterations: config.max_iterations };
}
```

### Builder invocation

```ts
async function run_builder(opts: BuilderOpts): Promise<void> {
  const system = compose_builder_system();
  const prompt = compose_builder_prompt({
    task: opts.prompt,
    criteria: opts.criteria,
    feedback: opts.feedback,
    iteration: opts.iteration,
  });

  const message_writer = open_jsonl_writer(opts.messages_log);

  try {
    for await (const msg of query({
      prompt,
      options: {
        cwd: opts.workspace,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: system },
        model: opts.model,
        permissionMode: 'acceptEdits',
        settingSources: ['project'],
      },
    })) {
      message_writer.write(msg);
    }
  } finally {
    message_writer.close();
  }
}
```

### Critic invocation

```ts
async function run_critic(opts: CriticOpts): Promise<void> {
  const system = opts.system_prompt;
  const prompt = compose_critic_prompt({
    criteria: opts.criteria,
    iteration: opts.iteration,
    check_result: opts.check_result,
  });

  const message_writer = open_jsonl_writer(opts.messages_log);
  const permission = make_critic_permission(opts.workspace);

  try {
    for await (const msg of query({
      prompt,
      options: {
        cwd: opts.workspace,
        systemPrompt: system,
        model: opts.model,
        canUseTool: permission,
        settingSources: [],
      },
    })) {
      message_writer.write(msg);
    }
  } finally {
    message_writer.close();
  }
}
```

### Critic prompt templates

Three built-in presets, each a short system prompt. The harness appends standard instructions about writing `.volley/feedback.md` and `.volley/verdict`.

**reviewer** (default)

```
You are a code reviewer. A builder agent has iterated on a workspace to satisfy
a task and acceptance criteria. Your job is to determine whether the acceptance
criteria are fully met.

Evaluate rigorously. If any criterion is partially met, ambiguous, or fragile,
treat it as unmet and provide concrete, actionable feedback.

Inspect the workspace using Read, Grep, Glob, and Bash (read-only commands) to
verify claims. Do not take the builder's word for anything; verify against the
actual files.
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

Appended to all critic system prompts:

```
You are running inside the volley harness. The workspace is at the current
working directory. The task iteration state is visible in .volley/iterations/.

You have read-only access to the workspace except for two files:
  - .volley/feedback.md
  - .volley/verdict

When you have finished your review:
1. Write your feedback to .volley/feedback.md as free-form markdown. Structure
   it however is clearest for the builder. The builder will read this file
   verbatim in the next iteration.
2. Write exactly one of "approved" or "changes_requested" (lowercase, no
   other characters, trailing newline permitted) to .volley/verdict.

Do not modify any other files. Do not run commands that modify the workspace.
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
<contents of .volley/feedback.md from previous iteration>

Address the feedback above. The workspace already contains your prior work;
read the current state, then make the necessary changes.
</if>
```

### Check command execution

```ts
async function run_check(opts: CheckOpts): Promise<CheckResult> {
  const proc = spawn('sh', ['-c', opts.command], {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const log_stream = create_write_stream(opts.log_path);
  proc.stdout.pipe(log_stream, { end: false });
  proc.stderr.pipe(log_stream, { end: false });

  const exit_code = await new Promise<number>((resolve) => {
    proc.on('close', (code) => resolve(code ?? 1));
  });

  log_stream.end();
  write_file(opts.exit_path, String(exit_code));

  const output = read_file(opts.log_path);
  return { passed: exit_code === 0, exit_code, output };
}
```

Check output is included in the critic's prompt context when check fails, so the critic can acknowledge the failure in its feedback and point the builder at it.

### Live output streaming

Every Agent SDK message yielded during builder and critic sessions is dispatched to two sinks in parallel:

1. **Persistent**: appended to the iteration's `builder.messages.jsonl` or `critic.messages.jsonl`. Unchanged regardless of display settings.
2. **Display**: rendered to the terminal according to the current verbosity level.

Rendering is message-grained, not token-grained. Agent SDK yields complete message events (assistant text, thinking, tool use, tool result); volley prints each event as it arrives. Sub-message token streaming is not supported in v1 (see §13).

#### Display format

Each rendered line is prefixed with `[<iter>] [<role>]` followed by a glyph and content. Glyph taxonomy:

| Glyph | Event |
|---|---|
| `💬` | Assistant text (model's prose output) |
| `💭` | Thinking block (dimmed; hidden with `--no-thinking`) |
| `🔧` | Tool call |
| `✅` | Tool result (success) |
| `❌` | Tool result (error) |
| `💰` | Usage/cost update |
| `▶` | Phase start (build, check, critique) |
| `✓` | Phase end (success) |
| `✗` | Phase end (failure) |

Color mapping: builder cyan, critic yellow, check green on pass / red on fail, cost magenta, errors bold red. Colors disabled if stdout is not a TTY, `VOLLEY_NO_COLOR` is set, or `NO_COLOR` is set (respects the `NO_COLOR` convention).

#### Verbosity levels

**Default**. Assistant text is printed in full. Thinking is printed in full unless `--no-thinking`. Tool calls are summarized: tool name + one-line input description (e.g. `🔧 Read src/math.ts` or `🔧 Bash: npm test`). Tool results are summarized: first line of output for success, full error message for failure. Cost is printed at end of each assistant turn.

**`--verbose`**. Same as default, but tool inputs and outputs are printed in full (truncated at 4000 characters with a `... [truncated; full content in jsonl log]` marker).

**`--quiet`**. Assistant text, thinking, and per-tool events are suppressed. Only printed: phase starts and ends, iteration summaries, cost updates, final summary.

**`--no-stream`**. Nothing is streamed. Only the final run summary is printed on exit. Equivalent to `--quiet` plus suppression of per-iteration output.

#### Implementation sketch

```ts
type stream_renderer = {
  on_message: (msg: SDKMessage, ctx: render_context) => void;
  on_phase_start: (phase: phase_name, ctx: render_context) => void;
  on_phase_end: (phase: phase_name, ctx: render_context, result: phase_result) => void;
  on_cost_update: (cost: cost_snapshot) => void;
};

function make_renderer(verbosity: verbosity_level): stream_renderer {
  // returns renderer appropriate for level
}

// In run_builder and run_critic, the message loop fans out:
for await (const msg of query({ /* ... */ })) {
  message_writer.write(msg);              // always
  renderer.on_message(msg, render_ctx);   // respects verbosity
  cost_tracker.ingest(msg);               // always
}
```

The renderer is a passive consumer; it never blocks the message stream. All formatting is synchronous writes to stdout. If the user pipes to a file or pager, output should still be readable line-by-line.

### Cost tracking

#### Data sources

Two sources, in order of preference:

1. **SDK-reported**. The Agent SDK emits a `result`-type message at the end of a session with `total_cost_usd`, `usage`, `num_turns`, `duration_ms`. When present, this is authoritative.
2. **Computed**. If the `result` message is absent or lacks `total_cost_usd`, volley computes cost from token counts on assistant messages against a pricing table.

Per-iteration summary records which source was used (`cost_source` field). Mixed sources across iterations in one run is allowed; the run-level total sums both.

#### Pricing table

Shipped as `src/pricing.ts`, exported as a typed record:

```ts
type model_pricing = {
  input_per_mtok_usd: number;
  output_per_mtok_usd: number;
  cache_write_per_mtok_usd: number;
  cache_read_per_mtok_usd: number;
};

export const PRICING: Record<string, model_pricing> = {
  'claude-opus-4-7':   { /* ... */ },
  'claude-opus-4-6':   { /* ... */ },
  'claude-sonnet-4-6': { /* ... */ },
  'claude-haiku-4-5':  { /* ... */ },
};
```

**Implementer note**: populate with current published prices from https://docs.claude.com/en/docs/about-claude/pricing at implementation time. Treat the pricing table as configuration data, not logic. Ship it with a dated header comment and a CI check that fails if the file has not been reviewed within 90 days.

Users can override via `VOLLEY_PRICING_PATH` pointing to a JSON file with the same shape, for cases where Anthropic pricing has changed between releases or a user is on negotiated enterprise pricing.

#### Cost calculation

```ts
function compute_cost(usage: TokenUsage, pricing: model_pricing): number {
  const input_cost       = (usage.input_tokens / 1_000_000) * pricing.input_per_mtok_usd;
  const output_cost      = (usage.output_tokens / 1_000_000) * pricing.output_per_mtok_usd;
  const cache_write_cost = (usage.cache_creation_input_tokens / 1_000_000) * pricing.cache_write_per_mtok_usd;
  const cache_read_cost  = (usage.cache_read_input_tokens / 1_000_000) * pricing.cache_read_per_mtok_usd;
  return input_cost + output_cost + cache_write_cost + cache_read_cost;
}
```

If a model ID is not in the pricing table, computed cost is `null` and `cost_source` is `"unknown"`. A warning is logged. SDK-reported cost is still used if available.

#### Cap enforcement

`--max-cost-usd` is checked at two points per iteration:

1. After builder completes, before check runs.
2. After critic completes, before deciding to start the next iteration.

If the running total exceeds the cap at either check, the current iteration is completed (no phases are aborted mid-session) and the loop exits with code 7. The final `summary.json` records `status: "cost_cap_reached"`.

The cap is not enforced mid-session; builder or critic sessions run to their natural conclusion. This is a deliberate tradeoff: aborting mid-session leaves the workspace in an undefined state, which is worse than a small cap overshoot. Operators who need a hard ceiling should set the cap below their actual ceiling by a margin proportional to one iteration's expected cost.

#### Live cost display

A compact cost line is printed after each assistant turn's usage update:

```
[iter 2] [builder] 💰 turn: $0.043 | phase: $0.218 | run: $0.591 / $20.00
```

Format: `turn: <this-turn> | phase: <builder-or-critic-so-far> | run: <total> / <cap-or-dash>`. If no cap is set, `/ <cap>` is omitted.

## §7 — Constraints

### Technical constraints

- Language: TypeScript, strict mode. `tsconfig.json` extends `@tsconfig/node20` or later.
- Runtime: Node.js 20 LTS or later. Single runtime target; no Bun/Deno support in v1.
- Style: Functional and procedural. No classes. No `this`. No inheritance. Use modules and plain functions. Types are `type` or `interface`; prefer `type` except where interface merging is needed.
- Naming: `snake_case` for variables, functions, parameters, and filenames. `PascalCase` for types. `SCREAMING_SNAKE_CASE` for module-level constants.
- Error handling: Return `Result<T, E>` style unions for recoverable errors; throw only for programmer errors. Top-level orchestrator catches and translates to exit codes.
- Agent SDK: `@anthropic-ai/claude-agent-sdk` v0.1 or later. Use the `query` async iterator API, not the callback API.
- No ORM, no database. All state in filesystem.
- Testing: Vitest. Unit tests for pure functions (prompt composition, config parsing, permission callbacks). Integration tests spawn the CLI against a fixture workspace with mock Agent SDK.
- Linting: Biome or ESLint + Prettier. Single config at repo root.

### Scope constraints (explicit non-goals for v1)

- No multi-provider support. Agent SDK is Anthropic-only; volley is Anthropic-only. If the user wants multi-provider loops, they use a different tool.
- No parallel iterations or multi-builder fan-out.
- No dollar-based budget enforcement. Only iteration count. (Deferred to §13.)
- No plan phase. The builder plans internally. If you need explicit plan/build/evaluate phases, use ridgeline.
- No resumption from mid-phase failures. Resumption only from completed iterations.
- No web UI, dashboard, or streaming viewer.
- No distributed execution.
- No automatic skill installation. Skills are user-provided via `.claude/skills/` in the workspace.
- No built-in MCP server configuration. MCP servers are loaded via Agent SDK's standard `.mcp.json` or settings; volley does not manage them.
- No critic memory across runs. Each run starts fresh.
- No "auto-escalation" (e.g., switch from Sonnet to Opus on iteration 3). Models are fixed for a run.

### Operational constraints

- Designed for local developer machines. No assumptions about cloud deployment.
- Workspace must be on a local filesystem (not a network mount, for performance).
- `--git` requires `git` on PATH and workspace to already be a git repo.
- Single-process execution. No daemon, no background workers.

## §8 — Dependencies

### Runtime dependencies

| Package | Purpose |
|---|---|
| `@anthropic-ai/claude-agent-sdk` | Builder and critic agent sessions. |
| `zod` | Config validation, CLI arg parsing schemas. |
| `commander` or `cac` | CLI argument parsing. Pick one; `cac` preferred for smaller footprint. |
| `chalk` or `picocolors` | Terminal color output. `picocolors` preferred. |
| `execa` | Robust child_process wrapper for the check command. |

### Development dependencies

| Package | Purpose |
|---|---|
| `vitest` | Test runner. |
| `typescript` | Compiler. |
| `@types/node` | Node types. |
| `@tsconfig/node20` | Base tsconfig. |
| `tsx` or `tsup` | Development runner / bundler. `tsup` for publishing. |

### Infrastructure dependencies

- Node.js 20+ on the host.
- `git` binary on PATH if `--git` is used.
- Anthropic API access via one of: `ANTHROPIC_API_KEY` env var, Claude subscription OAuth (Claude Code authenticated), or a custom `ANTHROPIC_BASE_URL` (e.g., Vercel AI Gateway).

## §9 — Failure Modes

| # | Scenario | Expected behavior | Verification |
|---|---|---|---|
| 1 | Workspace does not exist | Exit code 5, error: `workspace not found: <path>`. | Run `volley --workspace /nonexistent ...`, verify exit 5 and message. |
| 2 | Workspace not writable | Exit code 5, error: `workspace not writable`. | Run against a read-only directory, verify exit 5. |
| 3 | `--git` set but workspace is not a git repo | Exit code 5, error: `--git requires workspace to be a git repository`. | Run in a non-git dir with `--git`, verify exit 5. |
| 4 | `ANTHROPIC_API_KEY` set when user intended subscription | Warning printed at run start: `ANTHROPIC_API_KEY detected; usage will be billed via API, not subscription.` Run continues. | Set env var, run, verify warning in stderr. |
| 5 | Check command not found | Exit code 4, error: `check command failed to start: <error>`. | Use `--check nonexistent_bin`, verify exit 4. |
| 6 | Builder Agent SDK throws | Exit code 3. Current iteration state is preserved (partial messages log written). Error logged to stderr. | Mock Agent SDK to throw; verify exit 3 and log file presence. |
| 7 | Critic writes invalid verdict value | Exit code 6, error: `critic wrote invalid verdict: <value>; expected "approved" or "changes_requested"`. | Mock critic to write "maybe"; verify exit 6. |
| 8 | Critic does not write verdict file | Exit code 6, error: `critic did not write .volley/verdict`. | Mock critic that writes feedback but not verdict; verify exit 6. |
| 9 | Critic writes to forbidden path | Permission callback denies; critic receives error and may retry or abort. If critic abandons the task without writing verdict, case 8 applies. | Mock critic that tries to Edit a source file; verify permission denial. |
| 10 | Max iterations reached without success | Exit code 2. Final state preserved. stderr: `max iterations reached (<n>); last verdict: <v>, last check: <passed\|failed>`. | Run with `--max-iterations 1` on a task that cannot be completed in one pass. |
| 11 | SIGINT during a builder or critic call | Exit code 130. Current iteration's messages log is closed cleanly. Iteration directory is left as-is (not archived). Resumable. | Send SIGINT mid-run; verify logs exist and `resume` can continue. |
| 12 | Verdict file has trailing whitespace / newline | Normalized: trim whitespace before comparison. `approved\n` is accepted. | Write `"approved\n"`, verify success. |
| 13 | Verdict file is empty | Treated as critic error, case 7. | Mock critic that touches verdict but writes nothing; verify exit 6. |
| 14 | Workspace has `.volley/` from a previous run | On fresh run (not `resume`), rename existing `.volley/` to `.volley.bak.<timestamp>/` and continue with a new `.volley/`. | Run twice, verify first run's data is preserved in `.volley.bak.*`. |
| 15 | Cost cap reached | Exit code 7. Run summary `status: "cost_cap_reached"`. Current iteration completes naturally; cap is checked between phases, not mid-session. | Set `--max-cost-usd 0.01`, run, verify exit 7 after first iteration. |
| 16 | Unknown model (not in pricing table) | Warning logged: `pricing unknown for <model>; will use SDK-reported cost only`. Run continues. If SDK also does not report cost, run-level `total_cost_usd` is `null`. | Use `--builder-model claude-made-up-name`, verify warning and run continues. |
| 17 | SIGINT mid-phase, user hits Ctrl+C twice | First SIGINT begins graceful shutdown: stop reading new messages, close logs, exit 130. Second SIGINT within 3 seconds force-terminates immediately, potentially leaving incomplete jsonl. | Send two SIGINTs rapidly, verify process exits promptly. |
| 18 | Agent SDK yields partial `result` message without `total_cost_usd` | Fall back to computed cost from message-level usage data. `cost_source: "computed"`. No error. | Mock SDK to emit result without cost field; verify summary uses computed. |

## §10 — Success Criteria

### Automated tests (unit)

- **config_parsing**: Given a CLI arg vector, parser produces expected `VolleyConfig`. Covers all flags, `@file` prompt/criteria expansion, defaults, validation errors.
- **verdict_parsing**: Given file contents (including trailing whitespace, empty, invalid values), `read_verdict` returns correct enum or error.
- **critic_permission_callback**: Given tool name and input, permission callback returns allow/deny as specified. Table-driven test covering Write to allowed path, Write to forbidden path, Edit to allowed path, MultiEdit, Bash (allowed), Read (allowed).
- **builder_prompt_composition**: Given task/criteria/feedback/iteration inputs, output string matches fixture. Covers first iteration (no feedback) and later iterations.
- **iteration_dir_preparation**: Given a workspace, creates `.volley/iterations/001/` with correct permissions.
- **cost_computation**: Given a TokenUsage and pricing entry, `compute_cost` returns expected USD. Table-driven: zero usage, input-only, full mix including cache read/write, missing model in pricing table.
- **cost_source_preference**: When both SDK-reported and computed costs are available, summary records SDK-reported as the primary value and includes the computed value for audit. When only one is available, it is used.
- **renderer_verbosity**: Given a fixture sequence of SDK messages and a verbosity level, renderer produces expected stdout lines. Covers default, `--verbose`, `--quiet`, `--no-stream`, and `--no-thinking`.
- **cost_cap_enforcement**: Given a mock cost tracker that reports costs above the cap, the loop exits with code 7 after the current phase rather than starting the next iteration.

### Automated tests (integration)

- **fresh_workspace_happy_path**: Against a fixture workspace with a trivial prompt ("add a function `add(a, b)` to `src/math.ts`") and a check command (`npm test`), volley runs to completion in 1 or 2 iterations. Verifies exit 0, test passes, and `.volley/summary.json` contains non-zero `total_cost_usd`.
- **check_failure_feedback_loop**: Fixture where first build intentionally misses a test case. Verifies that the critic mentions the failing test in feedback and the builder addresses it in iteration 2.
- **budget_exhaustion**: Impossible task ("make this file contain both `foo = 1` and `foo = 2`"). Verifies exit 2 after max iterations.
- **resume**: Start a run, kill after iteration 2 completes, invoke `volley resume <run-id>`, verify iteration 3 begins with preserved config and cost accumulator continues from the prior total.
- **critic_readonly_enforcement**: Mock critic attempts to Edit a source file. Verify permission is denied and edit does not occur. Verify critic can still successfully write feedback.md and verdict.
- **cost_cap_halts_loop**: Configure `--max-cost-usd` at a value reachable in 1-2 iterations. Verify loop exits with code 7 after cap is crossed, not mid-session.
- **streaming_output_visible**: Run a trivial task with default verbosity. Verify stdout contains assistant text, tool summaries, cost lines, and phase markers. Verify jsonl logs are written regardless.
- **sigint_graceful**: Start a run, send SIGINT during a builder session. Verify process exits 130, builder jsonl log is a valid parseable sequence of complete SDK messages (no half-written line), iteration directory is preserved, and `volley resume` continues from the last completed iteration.

### Architectural validation

- No class declarations in `src/`. Grep for `^class ` and `^export class ` returns zero matches.
- No `this` usage in `src/` outside of imported library boilerplate. Grep for `this\.` at module scope returns zero.
- Every `src/` file has a single default-or-named export per responsibility. No barrel files (`index.ts` re-exporting).
- `src/orchestrator.ts` does not import from `src/agent/` directly; it imports from a small stable interface module that wraps the Agent SDK. This makes the Agent SDK mockable for tests.
- `src/critic/presets/` contains one markdown file per preset, not TypeScript string literals. Presets are discoverable by listing the directory.

### Learning outcomes

- Confirm that a "critic as Agent SDK with narrow write permission" pattern works well in practice, or identify where it breaks down (e.g., does the critic reliably follow the instruction to write both files every time?).
- Validate or refute the hypothesis that fresh context per iteration scales to ~20 iterations without degrading in quality vs continuing conversation.
- Surface whether the three-preset taxonomy (reviewer, optimizer, researcher) covers real use cases or collapses into "reviewer with different words."

## §11 — File Structure

```
volley/
  package.json
  tsconfig.json
  biome.json                      # or .eslintrc + prettier config
  README.md
  src/
    cli.ts                        # entry point, argv parsing, dispatch
    config.ts                     # VolleyConfig type, resolution, validation
    orchestrator.ts               # run_volley loop function
    workspace.ts                  # filesystem operations on workspace
    iteration.ts                  # prepare_iteration_dir, archive_*, summary
    verdict.ts                    # read_verdict, verdict type
    check.ts                      # run_check
    git.ts                        # git_commit, git_is_repo
    agent/
      client.ts                   # thin wrapper over Agent SDK query()
      permissions.ts              # make_critic_permission
    builder/
      run.ts                      # run_builder
      prompt.ts                   # compose_builder_system, compose_builder_prompt
    critic/
      run.ts                      # run_critic
      prompt.ts                   # compose_critic_prompt, resolve_critic_prompt
      presets/
        reviewer.md
        optimizer.md
        researcher.md
        harness_append.md         # appended to all critic prompts
    stream/
      renderer.ts                 # make_renderer, verbosity-aware rendering
      format.ts                   # glyph, color, and line composition helpers
    cost/
      tracker.ts                  # cost_tracker: ingest messages, running totals
      compute.ts                  # compute_cost from usage + pricing
      pricing.ts                  # PRICING table, load_pricing_override
    types.ts                      # shared types: RunResult, CheckResult, Verdict, TokenUsage, etc.
    exit_codes.ts                 # SCREAMING_SNAKE_CASE exit code constants
    logging.ts                    # minimal colored logger
  test/
    unit/
      config.test.ts
      verdict.test.ts
      permissions.test.ts
      builder_prompt.test.ts
      cost_compute.test.ts
      renderer.test.ts
    integration/
      happy_path.test.ts
      check_failure.test.ts
      budget_exhaustion.test.ts
      resume.test.ts
      critic_readonly.test.ts
      cost_cap.test.ts
      streaming_output.test.ts
      sigint.test.ts
    fixtures/
      trivial_math/
      failing_test/
      impossible/
  examples/
    reviewer/
      volley.config.ts
      acceptance.md
      prompt.md
    optimizer/
    researcher/
```

## §12 — Environment Variables

| Name | Required | Purpose | Example |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | conditional | Anthropic API key. Required unless Claude Code is authenticated via subscription OAuth. | `sk-ant-api03-...` |
| `ANTHROPIC_BASE_URL` | no | Override API endpoint (e.g., AI Gateway). Passed through to Agent SDK. | `https://ai-gateway.vercel.sh` |
| `ANTHROPIC_AUTH_TOKEN` | no | Used alongside `ANTHROPIC_BASE_URL` for gateway auth. Passed through to Agent SDK. | `<gateway token>` |
| `VOLLEY_LOG_LEVEL` | no | Logging verbosity. One of `error`, `warn`, `info`, `debug`. Default `info`. | `debug` |
| `VOLLEY_NO_COLOR` | no | Disable colored output. Any non-empty value disables. Also respects standard `NO_COLOR`. | `1` |
| `VOLLEY_NO_STREAM` | no | Disable live message streaming. Equivalent to `--no-stream`. | `1` |
| `VOLLEY_PRICING_PATH` | no | Path to a JSON file overriding the built-in pricing table. | `./custom-pricing.json` |

Ship a `.env.example` at repo root with commented entries for all of the above.

## §13 — Open Questions

1. **Token-level streaming.** v1 streams at message granularity: each complete SDK message (assistant text, tool call, tool result) is rendered when it arrives. The Agent SDK in some configurations supports sub-message token streaming for assistant text. Enabling this would give a more responsive feel but adds rendering complexity (partial line buffering, backtracking on edits, interaction with tool-call markers). Deferred; message-grained streaming is sufficient for monitoring and interruption.

2. **Mid-session cost abort.** v1 checks cost between phases, not mid-session. A builder session that goes off the rails could overshoot the cap significantly. Adding a mid-session abort would require coordinating with Agent SDK cancellation and leaves the workspace in an undefined state. Deferred; the between-phase granularity is acceptable for trusted prompts, and operators can set cap below their real ceiling.

3. **Sandboxed critic workspace.** Current design uses permission callbacks to restrict critic writes, which is a soft boundary around Bash. A stricter alternative is to run the critic against a read-only bind mount or a shallow git worktree of the workspace, with writes to `.volley/` sent to the real workspace via a separate channel. Deferred; the permission callback is likely sufficient for trusted local use and the worktree approach adds significant complexity.

4. **Critic retry on invalid verdict.** If the critic writes an invalid verdict value or forgets the verdict file, v1 exits with error 6. An alternative is to re-prompt the critic once with an explicit reminder. Deferred because: (a) it adds a special-case code path, (b) a critic that fails this instruction twice is probably failing in a way retry won't fix, (c) v1 should surface these bugs loudly so prompt templates can be improved.

5. **Pricing staleness detection.** v1 ships a static pricing table that CI enforces is reviewed every 90 days. A more dynamic alternative is to fetch current pricing from `docs.claude.com/en/docs/about-claude/pricing` at startup (or on a schedule) and cache locally. Deferred; static with CI pressure is simpler and pricing changes are rare enough that manual updates are manageable.

6. **Git checkpoint granularity.** `--git` commits after each phase (build, critique). An alternative is per-tool-call granularity (every file Write becomes a commit). Deferred; per-phase is the natural unit for post-hoc review and per-tool-call creates noise.

7. **Multi-critic consensus.** Run two or three critic sessions in parallel, approve only if all agree. Potentially valuable for high-stakes runs. Deferred; single critic is the minimum viable form and multi-critic can be a v2 feature flag.

8. **Interrupting mid-iteration for interactive feedback.** A mode where the loop pauses after each critic and asks the human operator to approve/override before continuing. Deferred; the primary use case is unattended autonomous runs.

9. **Resume with modified config.** Currently `volley resume` reuses the original config. Users may want to change the critic model or max iterations when resuming. Deferred; workaround is to edit `.volley/config.json` manually before resuming.

10. **Dashboard / TUI.** A richer interface (blessed, ink) with panes for builder output, critic output, cost counter, and iteration timeline. v1 uses line-oriented stdout for pipe-ability and simplicity. Deferred as a possible `volley-tui` sibling package.
