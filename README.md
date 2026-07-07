# volley

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
| `ollama` | [Ollama](https://ollama.com) | `VOLLEY_OLLAMA_URL` (`http://localhost:11434/api`) | `ai-sdk-ollama` |
| `lmstudio` | [LM Studio](https://lmstudio.ai) | `VOLLEY_LMSTUDIO_URL` (`http://localhost:1234/v1`) | `@ai-sdk/openai-compatible` |

Install the peer for your provider in the project running volley (e.g.
`pnpm add ai-sdk-ollama`); fascicle loads it lazily only when the local critic
actually runs. Local providers are free, so the critic's cost is reported as
`$0.000` and the run total reflects builder spend only.

Note the split by design: the builder — where agentic capability matters most —
stays on Claude, while the recurring per-iteration critic cost drops to zero.
A local *builder* is out of scope (it would need write/execute tooling the CLI
provides for free).

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

## Relationship to ridgeline

volley is a deliberate sibling to ridgeline, not a replacement. ridgeline
fixes plan/build/evaluate as three phases with strong context boundaries;
volley collapses planning into the builder's autonomy and makes evaluation
fully pluggable. Same substrate (fascicle), different opinions.
