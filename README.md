# volley

A Converging Loop:
A CLI harness that runs a **builder/critic loop** until a task passes both a
deterministic check pipeline and a natural-language acceptance review.

volley is built on two substrates:

- [fascicle](https://www.npmjs.com/package/fascicle) — the loop primitive, the
  `claude_cli` provider (one call = one complete agentic Claude Code session),
  usage/cost accounting, trajectory logging, and cancellation.
- [checkride](https://www.npmjs.com/package/checkride) — the deterministic
  check: one command, exit 0 = done, with a stable `.check/summary.json`
  contract whose raw per-tool output is fed straight to the critic.

## Set a cost cap

**Start here.** Since Anthropic's 2026-06-15 programmatic-billing change,
unattended runs are metered even for subscription users. Always run with
`--max-cost-usd`:

```sh
volley \
  --prompt "Implement the TODO items in src/parser.ts" \
  --workspace ./my-project \
  --criteria "All TODOs resolved; existing tests still pass" \
  --max-cost-usd 10
```

The cap is enforced in the loop guard after each phase. Sessions are never
killed mid-flight for cost (a builder killed mid-edit leaves the workspace
undefined), so set the cap below your true ceiling by roughly one iteration's
expected cost. Per-run totals land in `.volley/summary.json` and the final
terminal summary.

## How it works

```
prompt ──> builder (full agentic session in your workspace)
               │
           check (checkride --json, custom command, or none)
               │
           critic (read-only session; schema-validated verdict)
               │
        approved + check green? ── no ──> feedback → next iteration
               │ yes
             done
```

- **Builder** gets the task, the acceptance criteria, and the previous
  iteration's critic feedback. It has full tools (Read/Write/Edit/Bash) and
  runs with `--permission-mode acceptEdits` by default.
- **Check** is auto-detected: if the workspace uses checkride, volley runs
  `pnpm exec checkride --json` and gates on the summary. Any shell command
  works too (`--check "npm test"`), or `--check none` for critic-only runs.
- **Critic** is read-only (`Read`, `Grep`, `Glob` — no write path at all) and
  returns a schema-validated `{ verdict, feedback, unmet_criteria }`. The
  harness writes `.volley/feedback.md` and `.volley/verdict`; the critic
  cannot get them wrong.

Each iteration is a fresh session — no context carries over except through the
workspace filesystem and the critic's feedback. Swap the critic to change what
the loop optimizes for: `--critic reviewer` (default), `optimizer`,
`researcher`, or a path to your own system prompt.

## Install

Requires Node ≥ 24, pnpm, and the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
installed and authenticated.

```sh
pnpm add -g volley
```

## Usage

```
volley [options]
volley --config <path>
volley resume <run-id>
```

| Flag | Default | Description |
|---|---|---|
| `--prompt` | (required) | Task prompt. Literal string or `@path/to/file.md`. |
| `--workspace` | (required) | Workspace directory. Must exist and be writable. |
| `--criteria` | (required) | Acceptance criteria. Literal string or `@path`. |
| `--check` | `auto` | `auto` (checkride if detected, else none), `none`, or a shell command. |
| `--builder-model` | `opus` | `opus`/`sonnet`/`haiku` or a full model id. |
| `--builder-provider` | `claude_cli` | `claude_cli`, `ollama`, or `lmstudio` (see [Local builder](#local-builder)). |
| `--builder-max-steps` | `50` | Local builder tool-loop step cap per iteration. Ignored for `claude_cli`. |
| `--allow-unsandboxed-builder` | off | Permit a local builder to run without a sandbox (see [Local builder](#local-builder)). |
| `--critic-model` | `opus` | Model for the critic. |
| `--critic-provider` | `claude_cli` | `claude_cli`, `ollama`, or `lmstudio` (see [Local critic](#local-critic)). |
| `--builder-permission-mode` | `acceptEdits` | Or `bypassPermissions` for fully trusted workspaces. |
| `--critic` | `reviewer` | `reviewer`, `optimizer`, `researcher`, or a prompt file path. |
| `--max-iterations` | `10` | Hard iteration cap. |
| `--max-cost-usd` | none | Hard USD ceiling. Set it. |
| `--git` | off | Commit after each phase (workspace must be a git repo). |
| `--dry-run` | off | Validate config, run `checkride doctor`, exit. |
| `--config` | — | TypeScript config file (`VolleyConfig` default export). CLI flags override. |
| `--json` | off | Machine mode: one summary JSON document on stdout. |
| `--verbose` | off | Full tool inputs/outputs (truncated at 4000 chars). |
| `--quiet` | off | Phase transitions, cost lines, and the final summary only. |
| `--no-thinking` | off | Hide reasoning chunks (still recorded in the trajectory). |

Human-readable progress goes to **stderr**; stdout carries machine output
only, so volley composes under bigger harnesses the same way it composes
checkride.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Check passed and verdict approved. |
| 2 | Max iterations reached without success. |
| 3 | Builder/provider error. |
| 4 | Check pipeline error (broken pipeline, not failing checks). |
| 5 | Configuration error. |
| 6 | Critic error (schema validation failed after repair attempts). |
| 7 | Cost cap reached. |
| 130 | Interrupted (SIGINT); resumable. |

### Config file

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
};

export default config;
```

### Resume

```sh
volley resume <run-id>            # in the workspace directory
volley resume <run-id> --workspace ./my-project
```

Continues from the last completed iteration with the saved feedback and cost
totals. An iteration interrupted mid-phase is discarded and re-run.

## Local critic

The builder always runs on the Claude Code CLI, but the critic is read-only
and schema-constrained — a good fit for a cheaper local model. Point it at a
local provider with `--critic-provider`:

```sh
volley \
  --prompt "@task.md" --workspace ./my-project --criteria "@criteria.md" \
  --critic-provider ollama --critic-model qwen3:32b \
  --max-cost-usd 10
```

Instead of the CLI's built-in Read/Grep/Glob, a local critic gets volley's own
workspace-scoped read-only tools — `read_file`, `search_files`, `list_files` —
each confined to the workspace root (no write path, no path traversal). The
structured verdict contract is identical; fascicle validates and repairs the
local model's output the same way.

Providers and their setup:

| `--critic-provider` | Server | Base-URL env (default) | Required peer dependency |
|---|---|---|---|
| `ollama` | [Ollama](https://ollama.com) | `VOLLEY_OLLAMA_URL` (`http://localhost:11434`) | `ai-sdk-ollama` |
| `lmstudio` | [LM Studio](https://lmstudio.ai) | `VOLLEY_LMSTUDIO_URL` (`http://localhost:1234/v1`) | `@ai-sdk/openai-compatible` |

Install the peer for your provider in the project running volley (e.g.
`pnpm add ai-sdk-ollama@^3`); fascicle loads it lazily only when the local
critic actually runs. The major matters: it must satisfy fascicle's declared
peer range (`^3` for today's fascicle; a bare `pnpm add ai-sdk-ollama`
installs v4, which targets a newer AI SDK spec and fails at the first call).
The Ollama base URL is the **server root** — `ai-sdk-ollama` adds the `/api`
prefix itself (volley strips a trailing `/api` from `VOLLEY_OLLAMA_URL` for
compatibility). Local providers are free, so the critic's cost is reported as
`$0.000` and the run total reflects builder spend only.

Keeping the builder on Claude while the critic goes local is the low-risk split:
the recurring per-iteration critic cost drops to zero and the critic is
read-only, so a weaker local model can only mis-judge, never mis-edit. A local
*builder* is also supported ([below](#local-builder)) but asks more of you — it
gets a real host bash, so it is refused until you opt in.

## Local builder

`--builder-provider ollama|lmstudio` runs the builder on a local model too. A
local model brings no built-in tools, so volley supplies the whole agentic
surface itself — `read_file`, `search_files`, `list_files`, `write_file`,
`edit_file`, `bash`, `fetch`, and an explicit `finish` — and runs one bounded
tool loop per iteration (capped by `--builder-max-steps`, default 50; hitting
the cap is treated as partial work, not an error). The produced workspace goes
to check + critic exactly like a `claude_cli` build.

```sh
volley \
  --prompt "@task.md" --workspace ./my-project --criteria "@criteria.md" \
  --builder-provider ollama --builder-model qwen3-coder:30b \
  --allow-unsandboxed-builder \
  --check "pnpm check"
```

**A local builder runs unsandboxed and is refused by default.** Unlike the
read-only critic, the builder gets a real host `bash` (write + exec) in your
workspace, and volley has no container sandbox yet. So a local builder is
refused *before any model spend* unless you opt in with
`--allow-unsandboxed-builder` (or `VOLLEY_ALLOW_UNSANDBOXED_BUILDER=1`), which
prints a one-time warning. Only point it at a workspace you are willing to let a
local model run shell commands in. A container sandbox arrives in a later
session; this opt-out then becomes the "I already run in a devcontainer" escape
hatch.

Provider setup is the same as the [local critic](#local-critic) table
(`VOLLEY_OLLAMA_URL` / `VOLLEY_LMSTUDIO_URL`, same peer dependencies). At
builder start (and before a local critic's first verdict) volley pre-loads an
Ollama model with a load-only `/api/generate` call, so a cold multi-GB model
load doesn't eat the first real request's time-to-first-byte budget — without
it, a big cold model can die minutes in with an opaque
`stream interrupted: fetch failed`. Getting a
weak local model to drive a tool loop reliably has three sharp edges:

- **Set the context length to ≥ ~16k tokens.** Ollama's 4k default silently
  truncates the tool schemas volley sends, which is the single most common cause
  of a local model "ignoring" its tools — set `num_ctx` (e.g. a Modelfile
  `PARAMETER num_ctx 16384`, or the request-level option) before you blame the
  prompt. volley warns at builder start when it can read a too-small `num_ctx`
  off the Ollama server, but a window left at the server default is not
  reported back, so treat this as a required setup step rather than something
  the harness is guaranteed to catch.
- **Pin the model, runtime, and parser as one unit.** Tool-call dialects differ
  by model family (Qwen3 emits Hermes-style JSON; Qwen3-Coder emits XML), and
  crossing a model with the wrong runtime parser silently drops tool calls.
  volley salvages a call emitted as plain assistant text where it can (and
  records a per-run salvage rate in the iteration summary), but that is
  insurance, not a substitute for a matched runtime.
- **LM Studio 0.4.1+ has an Anthropic-compatible fallback.** If OpenAI-compat
  tool-call parsing misbehaves for a Qwen-class model, LM Studio 0.4.1+ ships an
  Anthropic-style `/v1/messages` endpoint (point `VOLLEY_LMSTUDIO_URL` at it)
  that field reports find more reliable for tool calling.

Local providers are free, so a local builder's cost is reported as `$0.000` and
never trips `--max-cost-usd`.

## Run artifacts

Everything volley knows lives in the workspace:

```
.volley/
  config.json          # resolved run config (immutable per run)
  summary.json         # run-level usage, cost, status
  trajectory.jsonl     # every fascicle trajectory event (fascicle-viewer replays it)
  feedback.md          # current critic feedback (harness-written)
  verdict              # approved | changes_requested (harness-written)
  iterations/NNN/      # per-iteration archive: feedback, verdict, check artifacts, summary
```

A stale `.volley/` from a previous run is rotated to `.volley.bak.<timestamp>/`.

## Environment variables

See [.env.example](./.env.example): `VOLLEY_CLAUDE_BIN`, `VOLLEY_AUTH_MODE`,
`VOLLEY_LOG_LEVEL`, `VOLLEY_NO_COLOR`, `VOLLEY_PRICING_PATH`, and the
`ANTHROPIC_API_KEY` billing-meter warning.

## Development

```sh
pnpm install
pnpm test          # vitest
pnpm typecheck     # tsc --noEmit
pnpm check         # checkride — volley dogfoods its own definition of done
pnpm build         # tsup → dist/
```

Live smoke tests against the real `claude` CLI and real checkride are opt-in:

```sh
VOLLEY_LIVE=1 pnpm test
```

The local-builder live test needs a running local runtime, so it gates on an
extra opt-in naming the provider that is actually up:

```sh
VOLLEY_LIVE=1 VOLLEY_LIVE_BUILDER_PROVIDER=ollama \
  VOLLEY_LIVE_BUILDER_MODEL=qwen3-coder:30b pnpm test
```

## Relationship to ridgeline

volley is a deliberate sibling to ridgeline, not a replacement. ridgeline
fixes plan/build/evaluate as three phases with strong context boundaries;
volley collapses planning into the builder's autonomy and makes evaluation
fully pluggable. Same substrate (fascicle), different opinions.
