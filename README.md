# volley

[![CI](https://github.com/robmclarty/volley/actions/workflows/ci.yml/badge.svg)](https://github.com/robmclarty/volley/actions/workflows/ci.yml)

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

## Status

volley is a personal research harness. I built it to study builder/critic
loops on local models, and that is what I use it for. It is not (yet) meant
for broad use:

- **v0.x.** CLI flags, the config shape, and the `--json` output change
  without notice. Read [CHANGELOG.md](./CHANGELOG.md) before upgrading.
- **Pinned substrates.** It pins specific versions of fascicle and checkride
  and is only tested against those.
- **A local builder runs a real shell.** Read [Local builder](#local-builder)
  before pointing one at anything you care about.
- **No support commitment.** Issues and findings are welcome; open an issue
  before sending a large PR.

The design record lives in [`research/`](./research/) (specs and run
findings) and [`.plumbbob/`](./.plumbbob/) (build plans and logs).

## Set a cost cap

**Start here.** A volley run is a loop of complete agentic sessions, so it
spends faster than anything you drive by hand. With `ANTHROPIC_API_KEY` set,
every session bills the key at API rates. On a subscription, `claude_cli`
draws from your plan's usage limits — Anthropic announced a separate metered
credit for programmatic use in May 2026, then
[paused it on June 15](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
before it took effect. Either way, always run with `--max-cost-usd`:

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
terminal summary. An [OpenRouter](#openrouter) seat's cost is the charge
OpenRouter reports for each call, so the cap trips on one as on any other.

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
  returns a schema-validated `{ verdict, feedback, unmet_criteria }`. It is told
  which files the builder changed, so it reviews a change rather than a tree.
  The harness writes `.volley/feedback.md` and `.volley/verdict`; the critic
  cannot get them wrong.

Each iteration is a fresh session — no context carries over except through the
workspace filesystem and the critic's feedback. Swap the critic to change what
the loop optimizes for: `--critic reviewer` (default), `optimizer`,
`researcher`, or a path to your own system prompt.

### The flow

Under the hood the loop is one [fascicle](https://www.npmjs.com/package/fascicle)
composition in [`src/flow.ts`](./src/flow.ts), and fascicle's `describe.diagram`
draws it straight from the code. It shows what the sketch above leaves out: the
branch that skips verification once the builder alone crosses the cost cap, the
critic's retry-then-tool-less fallback on every provider but `claude_cli`, and
the guard that decides when the loop stops.

<!-- flow diagram: pnpm diagram -->
```text
volley                                loop: one round per iteration, up to max_iterations
├─ iteration                          sequence
│  ├─ build                           open the iteration, run the builder, measure the change
│  │  └─ builder                      model call: one agentic session in the build root
│  ├─ verify                          branch: did the build alone cross the cost cap?
│  │  ├─ then  skip_verify            record the check as skipped and call no critic
│  │  └─ else  sequence
│  │     ├─ check                     the deterministic gate: checkride, a command, or none
│  │     └─ critique                  the read-only critic's verdict and feedback
│  │        └─ critic                 fallback: judge without tools if a critic on any provider but claude_cli keeps dying or runs out of steps
│  │           ├─ retry               one more try after a stream death, on any provider but claude_cli
│  │           │  └─ critic_tools     model call with read-only workspace tools
│  │           └─ pipe                mark the verdict degraded
│  │              └─ critic_toolless  model call judging from the check output and a file list
│  └─ record                          archive the iteration and rewrite the run summary
└─ guard  gate                        stop on approval over a green check, the cost cap, or a gate edit
```

`pnpm diagram` prints the same tree from a checkout. A test holds this copy and
the one in the `src/flow.ts` header to what the code builds, so neither drifts.

## Install

Requires Node ≥ 24 and pnpm. The default seats run on the
[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), installed and
authenticated; seats on [OpenRouter](#openrouter) or a
[local model server](#local-critic) don't need it.

From a checkout:

```sh
git clone https://github.com/robmclarty/volley.git && cd volley
pnpm install && pnpm build
pnpm link --global   # puts `volley` on your PATH
```

Or from npm, where the package is scoped (the bare `volley` name belongs to an
unrelated project); the binary is still `volley`:

```sh
pnpm add -g @robmclarty/volley
```

## Usage

```
volley [options]
volley --config <path>
volley resume <run-id>
volley matrix --builders <models> --critics <models> --config <path>
volley acp --builder-provider <name> --builder-model <model> \
  --critic-provider <name> --critic-model <model> [options]
```

| Flag | Default | Description |
|---|---|---|
| `--prompt` | (required) | Task prompt. Literal string or `@path/to/file.md`. |
| `--workspace` | (required) | Workspace directory. Must exist and be writable. |
| `--criteria` | (required) | Acceptance criteria. Literal string or `@path`. |
| `--check` | `auto` | `auto` (checkride if detected, else none), `none`, or a shell command. |
| `--builder-model` | `opus` | `opus`/`sonnet`/`haiku` or a full model id. |
| `--builder-provider` | `claude_cli` | `claude_cli`, `ollama`, `lmstudio`, or `openrouter` (see [Local builder](#local-builder) and [OpenRouter](#openrouter)). |
| `--builder-url` | the provider's env var | The builder's model server base URL, for `ollama`, `lmstudio`, or `openrouter` only. Lets the builder and critic run on different machines with the same provider (see [Seats on different machines](#seats-on-different-machines)). |
| `--builder-max-steps` | `50` | Tool-loop builder step cap per iteration. Ignored for `claude_cli`. |
| `--allow-unsandboxed-builder` | off | Permit a builder other than `claude_cli` to run without a sandbox (see [Local builder](#local-builder)). |
| `--critic-model` | `opus` | Model for the critic. |
| `--critic-provider` | `claude_cli` | `claude_cli`, `ollama`, `lmstudio`, or `openrouter` (see [Local critic](#local-critic) and [OpenRouter](#openrouter)). |
| `--critic-url` | the provider's env var | The critic's model server base URL, for `ollama`, `lmstudio`, or `openrouter` only. |
| `--builder-permission-mode` | `acceptEdits` | Or `bypassPermissions` for fully trusted workspaces. |
| `--critic` | `reviewer` | `reviewer`, `optimizer`, `researcher`, or a prompt file path. |
| `--max-iterations` | `10` | Hard iteration cap. |
| `--max-cost-usd` | none | Hard USD ceiling. Set it. |
| `--git` | off | Commit after each phase (workspace must be a git repo). |
| `--worktree` | off | Isolate the builder run in a per-run git worktree (workspace must be a git repo). Without `--git`, a successful run's work is kept on the run branch — see [Local builder](#local-builder). |
| `--discard-worktree` | off | Throw a `--worktree` run's effects away at teardown instead of keeping them on the run branch. Requires `--worktree`. |
| `--gate-paths` | (built-in list) | Comma-separated globs naming the gate — tests, fixtures, check config. Replaces the defaults; see [What the builder changed](#what-the-builder-changed). |
| `--fail-on-gate-edit` | off | Halt the run (exit 8) if the builder edits a gate path, instead of reporting it. |
| `--sandbox-image` | `volley-sandbox:latest` | Container image for the local-builder sandbox. Or `VOLLEY_SANDBOX_IMAGE`. |
| `--state-dir` | the workspace's `.volley/` | Keep each run's state under `<path>/<run id>/` instead, and none in the workspace (see [Run artifacts](#run-artifacts)). Or `state_dir` in a config file. |
| `--run-id` | a fresh UUID | The run's id, naming its run state and its `volley/<id>` branch, so a harness that owns the id finds it in both. Letters, digits, `-`, and `_`, starting with a letter or digit. |
| `--dry-run` | off | Validate config, run `checkride doctor`, probe each tool-loop seat's model endpoint (local or OpenRouter), run the critic-seat canary (for a local critic), then exit. |
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
| 8 | The builder edited the gate and `--fail-on-gate-edit` was set. |
| 130 | Interrupted (SIGINT); resumable. |

### Config file

```ts
// volley.config.ts
import type { VolleyConfig } from '@robmclarty/volley';

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
volley resume <run-id> --state-dir ~/volley-runs   # a run started with --state-dir
```

Given the root a run was started under, `resume` finds it at
`<root>/<run-id>/` from any directory, since the run's recorded config names its
workspace.

Continues from the last completed iteration with the saved feedback and cost
totals. An iteration interrupted mid-phase is discarded and re-run.

### Matrix sweep

Finding the best builder×critic pairing means running the same task against
several model combos and comparing. `volley matrix` sweeps the cross product
serially over one fixed config instead of hand-editing model flags per run:

```sh
volley matrix \
  --config ./examples/essayist/volley.config.ts \
  --builders qwen3.6:latest \
  --critics qwen3:8b,gemma4:12b,glm-4.7-flash \
  --repeat 3
```

| Matrix flag | Description |
|---|---|
| `--config` | Base `VolleyConfig` (TS/JS): the task, workspace, providers, seat URLs, and caps held fixed. Required. |
| `--builders` | Comma-separated builder models to sweep. |
| `--critics` | Comma-separated critic models to sweep. |
| `--repeat` | Attempts per seat (default 1). A pass *rate* needs more than one. |
| `--workspace` | Override the base config's workspace. |
| `--json` | Machine mode: the aggregate as JSON on stdout, no table. |
| `--verbose` | Show full builder/critic streams per combo. |
| `--quiet` | Per-combo phase transitions and the final table only. |

`--builders` and `--critics` are comma-separated model lists; every combination
runs `--repeat` times (`--builder-model` × `--critic-model`), in series — the
local providers share one GPU, so parallel combos would thrash the model loader.
Each run forces `--worktree --discard-worktree` for a clean per-run reset — a
sweep wants verdicts, so each seat's effects are isolated and then thrown away,
leaving neither a branch nor a commit behind — so the **workspace must be a git
repository**. Every attempt's run state is written to
`.volley-matrix/<builder>__<critic>/run-NN/summary.json`, the whole sweep to
`.volley-matrix/matrix.json`, and one aggregate table goes to stderr:

```
builder         critic         pass  iters  wall    cost   salvage  flags       why
──────────────  ─────────────  ────  ─────  ──────  ─────  ───────  ──────────  ──────────────────
qwen3.6:latest  qwen3:8b       3/3   1.0    403.4s  $0.00  0%       —           —
qwen3.6:latest  gemma4:12b     2/3   1.5    512.0s  $0.00  0%       —           unmet: 2 criteria
qwen3.6:latest  glm-4.7-flash  0/3   —      184.0s  $0.00  12%      deg:stream  check: types, test
```

**Why `--repeat`.** One run answers "did this pairing converge that time", and
that is all n=1 can honestly answer: local runs are stochastic. A single sample
supports a *hard* failure (the qwen3.6 critic death reproduced 2/2 in
[`research/v3-comparison-finding.md`](./research/v3-comparison-finding.md)) and
nothing else — not iterations-to-converge, not wall clock. With `--repeat` the
`pass` column is a rate, and the averages behind it are over the attempts that
can support them: `iters` averages the *converged* attempts only, `wall` and
`cost` average every attempt that reported one, and `salvage` is a ratio of
totals rather than a mean of ratios.

**Why a seat fell off** is the `why` column — the point of a ladder sweep.
`budget_exhausted` is a status, not a diagnosis, so the row instead names the
failing check slots, the criteria the critic still judged unmet, a cost cap, a
gate edit, or the error that broke the run. `flags` carries what qualifies a
pass rather than explaining a failure: `deg` for a degraded critic verdict,
named for what degraded it (`deg:stream` when the critic's stream kept dying,
`deg:steps` when it ran out of steps), and `gate` for a builder that edited the
gate. Every attempt's full detail —
statuses, verdicts, failing slots, unmet criteria, gate edits — is in the
`--json` aggregate and in `matrix.json`.

A run that does not converge is a *result*, shown in the table; the sweep exits
0 as long as every attempt produced a summary, and nonzero only when one
produced none at all (`status: broke`).

## Local critic

The critic is read-only and schema-constrained, which makes it a good fit for
a cheaper local model even when the builder stays on Claude. Point it at a
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
| `ollama` | [Ollama](https://ollama.com) | `VOLLEY_OLLAMA_URL` (`http://localhost:11434`) | `ai-sdk-ollama@^4.3.0` |
| `lmstudio` | [LM Studio](https://lmstudio.ai) | `VOLLEY_LMSTUDIO_URL` (`http://localhost:1234/v1`) | `@ai-sdk/openai-compatible` |

Install the peer for your provider in the project running volley (e.g.
`pnpm add ai-sdk-ollama@^4.3.0`); fascicle loads it lazily only when the local
critic actually runs. The version matters. The major must satisfy fascicle's
declared peer range (`^4` for fascicle 0.16.3, which tracks the AI SDK v7
line), and volley declares 4.3.0 as its floor (an optional peer, so your
package manager flags an older copy at install time). Before 4.3.0,
ai-sdk-ollama streams a thinking model's reasoning only when the request sets
`think`, which volley never does: the reasoning disappears from the terminal
and the trajectory, and the phase's throughput reads high. A bare
`pnpm add ai-sdk-ollama` installs the latest 4.x, which clears the floor.
The Ollama base URL is the **server root** — `ai-sdk-ollama` adds the `/api`
prefix itself (volley strips a trailing `/api` from `VOLLEY_OLLAMA_URL` for
compatibility). Local providers are free, so the critic's cost is reported as
`$0.000` and the run total reflects builder spend only.

The env var sets a provider's URL for both seats. To give the critic a server
of its own, pass `--critic-url` (`critic_url` in a config file). A seat uses its
own URL, then the provider's env var, then the default, and never the other
seat's URL; see [Seats on different machines](#seats-on-different-machines).

Keeping the builder on Claude while the critic goes local is the low-risk split:
the recurring per-iteration critic cost drops to zero and the critic is
read-only, so a weaker local model can only mis-judge, never mis-edit. A local
*builder* is also supported ([below](#local-builder)) but asks more of you — it
gets a real host bash, so it is refused until you opt in.

**A caveat on the critic model.** The critic seat is the one place volley pairs a
tool surface with a constrained structured verdict, and not every local model
survives that combination. `qwen3.6:latest` in the critic seat reproducibly dies
on Ollama's server-side tool-call XML parser (`qwen35.go` / `qwen3coder.go`) —
the *same* model drives the builder tool loop fine, so the defect is specific to
the constrained-verdict path. volley no longer lets that kill a run: the critic
phase degrades (a bounded retry, then a tool-less fallback that keeps the
schema), marks the verdict `critic_degraded: true`, and `--dry-run` predicts the
doomed combo up front with a critic-seat canary. A critic that runs out of steps
before its verdict (its 10-step budget spent, or its last turn a tool call) skips
the retry, since another identical tool loop would only run out again, and goes
straight to the tool-less pass. The record's `degrade_cause` says which happened:
`stream_error` or `step_exhaustion`. A verdict cut off by the token limit or
blocked by a content filter isn't degraded: it fails the critic phase (exit 6)
with the finish reason in the message, because taking the tools away fixes
neither. Even so, prefer a critic whose
tool-call encoding Ollama parses cleanly — `qwen3:8b`, `gemma4:12b`, and
`glm-4.7-flash` all pass. The full model-vs-transport write-up is in
[`research/v3-comparison-finding.md`](./research/v3-comparison-finding.md).

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

**A local builder gets a real host `bash`, so it is refused unless contained.**
Unlike the read-only critic, the builder gets a real `bash` (write + exec) in
your workspace. So a local builder is refused *before any model spend* unless
volley detects it is running *inside* its own hardened sandbox container — the
operator launches volley there with `docker run <hardened flags>
volley-sandbox:latest volley …`, which sets `VOLLEY_CONTAINED=1` (baked into the
image; volley detects containment, it does not start the container itself). The
container gives default-deny network egress with a host-gateway allowlist; the
hardened `docker run` spec lives in `src/sandbox.ts` and is exported
(`sandbox_run_args`, `network_run_args`, and the bridge's
`SANDBOX_NETWORK_NAME` and `SANDBOX_NETWORK_SUBNET`) so a harness that launches
the container renders the same flags rather than a copy, and `--sandbox-image` /
`VOLLEY_SANDBOX_IMAGE` overrides the default `volley-sandbox:latest`. Inside the
container, `claude_cli`'s subscription/OAuth token does not survive — it is
mangled crossing the boundary — so a *contained* Claude role must drive by API
key (`VOLLEY_AUTH_MODE=api_key` with `ANTHROPIC_API_KEY`); the all-Claude
subscription path stays on the host, Docker-free.

To run a local builder uncontained on the host anyway, opt out with
`--allow-unsandboxed-builder` (or `VOLLEY_ALLOW_UNSANDBOXED_BUILDER=1`), which
prints a one-time warning — only point it at a workspace you are willing to let a
local model run shell commands in.

Independently of the sandbox, `--worktree` isolates a run in a per-run git
worktree on a branch named `volley/<run id>` (the workspace must be a git repo),
so the builder's effects never touch your working tree while the loop runs. What
becomes of those effects when the run converges depends on two flags — volley
prints which one applies at `--dry-run` and again at run start, so it is never a
surprise at teardown:

| Flags | A successful run's work |
|---|---|
| `--worktree --git` | Squash-merged onto the workspace branch, then the run branch is deleted. |
| `--worktree` | Committed onto `volley/<run id>` and left there. Recover it with `git switch volley/<run id>` or `git cherry-pick`; the branch is named in the final summary and in `--json` as `salvaged_branch`. |
| `--worktree --discard-worktree` | Thrown away with the branch — verdicts only, nothing kept. |

Any run that does *not* converge (cost cap, budget exhausted, interrupt, error)
is discarded wholesale in all three modes: an abandoned phase leaves nothing
behind.

Provider setup is the same as the [local critic](#local-critic) table
(`VOLLEY_OLLAMA_URL` / `VOLLEY_LMSTUDIO_URL`, or `--builder-url` for the builder
alone; same peer dependencies). At
builder start (and before a local critic's first verdict) volley pre-loads an
Ollama model with a load-only `/api/generate` call, so a cold multi-GB model
load doesn't eat the first real request's time-to-first-byte budget — without
it, a big cold model can die minutes in with an opaque
`stream interrupted: fetch failed`. (That cold-load timeout is an
ai-sdk/undici in-request limit, not an Ollama one: on fascicle's native
transport — a documented future option, not the path volley runs today — the
per-turn call is a raw `fetch` with no in-request timeout, so this pre-load's
necessity drops away and the `num_ctx`/`keep_alive` levers below move to
per-call `provider_options.ollama`.) Getting a
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

### Seats on different machines

Each seat can reach its own model server, so the builder and the critic can run
on different machines even when they use the same provider. Give each seat a
URL with `--builder-url` and `--critic-url`, or in a config file:

```ts
const config: VolleyConfig = {
  // ...the task...
  builder_provider: 'ollama',
  builder_model: 'qwen3-coder:30b',
  builder_url: 'http://localhost:11434', // this machine
  critic_provider: 'ollama',
  critic_model: 'qwen3:8b',
  critic_url: 'http://localhost:11522', // a second machine, forwarded here
};
```

- **Fallback.** A seat without a URL of its own uses the provider's env var,
  then the default, never the other seat's URL.
- **Same rules as the env var.** Ollama's trailing `/api` is dropped. The URL
  must be plain `http(s)`, with no credentials, query, or fragment. Include the
  port: a URL without one goes to 80 or 443, not the provider's default.
- **`claude_cli` takes no URL.** Setting one on a `claude_cli` seat is a
  configuration error (exit 5).
- **Everything a seat sends goes to its own URL.** That covers the model calls,
  the Ollama prewarm and context check, and the `--dry-run` endpoint probe and
  critic canary. `volley matrix` holds both URLs fixed across every pairing.

Inside the sandbox container, a loopback seat URL crosses to the host at
`VOLLEY_MODEL_HOST` the way the env var does, keeping its port. So the two seats
can be two forwarded ports on the host (`localhost:11522`, `localhost:11523`).
With the allowlist's host rules in place the container reaches only the host
gateway, so it can reach a seat on another machine only through a port forward
on the host, for example `ssh -N -L 11522:localhost:11434 gpu-box`. On a Linux
host, `host-gateway` is the Docker bridge's address, so the forward, like Ollama
itself, has to listen there rather than on `127.0.0.1` alone.

## OpenRouter

`--builder-provider openrouter` and `--critic-provider openrouter` put a seat on
[OpenRouter](https://openrouter.ai), so one API key runs both seats, Claude
included, with no Claude Code CLI and no local model server:

```sh
OPENROUTER_API_KEY=sk-or-v1-... volley \
  --prompt "@task.md" --workspace ./my-project --criteria "@criteria.md" \
  --builder-provider openrouter --builder-model anthropic/claude-sonnet-5.5 \
  --critic-provider openrouter --critic-model anthropic/claude-haiku-5.5 \
  --allow-unsandboxed-builder --max-iterations 3
```

- **The key.** `OPENROUTER_API_KEY` is required whenever either seat is on
  `openrouter`. Unset, volley exits 5 naming it, before any work. It goes out
  as a Bearer token, with `X-Title: volley` so OpenRouter attributes the
  traffic.
- **The URL.** `VOLLEY_OPENROUTER_URL` (default `https://openrouter.ai/api/v1`)
  points both seats at a proxy or another OpenAI-compatible gateway, and
  `--builder-url` / `--critic-url` give one seat a URL of its own, under the
  rules in [Seats on different machines](#seats-on-different-machines).
  OpenRouter runs on fascicle's native transport, so there's no peer to
  install, and the run summary records the transport as `native`.
- **The seats.** An OpenRouter seat runs volley's tool loop, the same as a
  local one. The builder gets volley's tools, `bash` included, so it's refused
  uncontained unless you opt out, exactly like a
  [local builder](#local-builder). The critic gets the read-only tools and the
  same retry-and-degrade ladder as a [local critic](#local-critic).
  `--dry-run` probes each OpenRouter seat's endpoint but runs no critic canary,
  which would cost money here.
- **Cost and reasoning.** OpenRouter reports what each call cost, and that
  charge is the seat's cost, recorded as `provider_reported`, so
  `--max-cost-usd` trips on an OpenRouter seat as on any other. A model that
  reasons streams its reasoning, which the terminal shows dimmed unless
  `--no-thinking` hides it, and which Zed shows as a thought.
- **In the sandbox.** The container's allowlist reaches only the host gateway,
  so a contained OpenRouter seat needs `openrouter.ai` let through your
  `DOCKER-USER` rules. volley doesn't install that rule for you.

## Run volley from Zed

`volley acp` serves volley to an editor over the
[Agent Client Protocol](https://agentclientprotocol.com), through fascicle's
`serve_acp`, so a prompt in [Zed](https://zed.dev)'s agent panel starts a volley
run on the folder Zed has open. The builder's work streams in as the reply, each
round opens with a **Round N** line, the check shows as a command card, the
critic's verdict arrives as a thought, and the turn ends with a summary.

```sh
volley acp \
  --builder-provider openrouter --builder-model anthropic/claude-sonnet-5.5 \
  --critic-provider openrouter --critic-model anthropic/claude-haiku-5.5 \
  --check "pnpm test"
```

It reads the protocol on stdin and writes nothing but the protocol to stdout,
with its own progress on stderr, which Zed shows in its agent log. Zed starts it
for you ([below](#zed-setup)).

### Each prompt is a run

- **Fresh, in place.** Each prompt is a new volley run on the open folder, with
  no worktree. Its task and its acceptance criteria are both the conversation so
  far, then the new prompt. An earlier reply keeps only its last 2,000
  characters, where its summary sits. An earlier prompt's attached files shrink
  to a line naming each, since they're still on disk. A turn you stopped is
  marked as stopped.
- **Three rounds.** `--max-iterations` defaults to 3 per prompt, not 10, since
  a prompt is one short exchange, and `--max-cost-usd` caps what it spends.
  Follow a run that didn't converge with "keep going": the summary it ended
  with lists what the critic still found missing.
- **The tools.** The builder gets fascicle's workspace tools (`read_file`,
  `list_files`, `search`, `write_file`, `edit_file`, `run_command`) plus
  volley's `finish`. The critic gets the three reads. Both stay inside the open
  folder, and neither gets `fetch`. volley doesn't offer the editor additional
  directories, so in a workspace with several folders Zed opens the session on
  the first, and a client that sends more anyway has its session refused.
- **The summary.** The turn's last message says whether the run converged, in
  how many rounds, and with what last verdict. When it didn't converge, it
  lists the unmet criteria, and it names any gate edits and any verdict the
  critic reached without its tools. A run that fails ends with a summary saying
  in which round and phase, and why, so "try again" has a request to retry.
- **Stop.** Pressing stop ends the turn as cancelled, and kills a running
  command or check along with its whole process group.

### Flags and refusals

`volley acp` takes the run command's seat flags, and requires four of them:
`--builder-provider`, `--builder-model`, `--critic-provider`, and
`--critic-model`. A missing one is refused with every missing flag named. The
rest are optional: `--builder-url`, `--critic-url`, `--builder-max-steps`,
`--allow-unsandboxed-builder`, `--critic`, `--check`, `--max-iterations`,
`--max-cost-usd`, and `--state-dir`.

It refuses these before serving, each with exit 5:

| Refused | Why |
|---|---|
| `--worktree` | A sibling worktree sits outside the project the editor has open. |
| `--git` | It commits to the open repo after every phase, which no permission prompt covers. |
| `--json` | Stdout carries the protocol alone. |
| a `claude_cli` builder | The Claude CLI runs its own tools under its own permission model, so its edits would never reach the editor's prompts. |

A `claude_cli` critic is allowed: it only reads, and it runs on the host, where
its login works. The whole config resolves once at startup, so a bad flag or an
unset `OPENROUTER_API_KEY` exits 5 there, where Zed's agent log shows it, rather
than failing every prompt.

### Modes and approvals

Each session starts in Manual. Zed's mode picker switches it, and a switch holds
from the next call on, mid-turn included:

| Mode | Asks before an edit | Asks before a command |
|---|---|---|
| Manual | yes | yes |
| Accept edits | no | yes |
| Auto | no | no; offered only contained or opted out (below) |

An edit asks with its diff, and offers "Allow all edits this session", which
switches the session to Accept edits. A command offers "Always allow" for that
exact command line: allowing `pnpm test` doesn't cover `pnpm test --watch=false`,
which asks again. It never offers one for a command with shell control syntax
such as `;` or `|`. A call you reject reaches the builder as
`tool_approval_denied`, and its prompt tells it not to reach the same result
another way.

- **Uncontained, Auto isn't offered.** Outside volley's
  [sandbox container](#local-builder) (`VOLLEY_CONTAINED`), a person approving
  each command takes the container's place, so the mode picker lists Manual and
  Accept edits alone, and the builder's `run_command` asks in both. No client
  can switch the session to Auto, mid-turn included. A Zed entry left on Auto
  (`"default_config_options": { "mode": "auto" }`, from a time it was offered)
  falls back to Manual, with a warning in Zed's log.
  `--allow-unsandboxed-builder` or `VOLLEY_ALLOW_UNSANDBOXED_BUILDER=1` opts
  out, and Auto is offered again. So unlike the run command, `volley acp` never
  refuses an uncontained builder.
- **The check asks whenever a command would.** In Accept edits and Auto the
  builder can rewrite a test without asking, and the check runs it next. So the
  check asks on its own card exactly when a builder command would ask, offering
  only Allow and Reject, since an "always" for checkride's `pnpm exec` would
  cover the builder's commands too. A rejected check counts as a failed one, so
  a round can't converge on work nobody checked.
- **No keys in commands.** The builder's commands and the check run with the
  agent's environment minus `OPENROUTER_API_KEY` and `ANTHROPIC_API_KEY`,
  `PATH` kept, so nothing the builder writes can read the key a seat runs on.

### Where its state goes

Nothing of volley's own lands in the repo. Each prompt's run state goes to
`<root>/<run id>/`, where the root is `--state-dir`, else
`$XDG_STATE_HOME/volley`, else `~/.local/state/volley`. Nothing prunes old runs.
The whole root is safe to delete whenever no prompt is running. A run's
`trajectory.jsonl` there replays in `fascicle-viewer` like a CLI run's
([Run artifacts](#run-artifacts)).

### Zed setup

Run `pnpm build` first: Zed runs `dist/cli.js`, and nothing else rebuilds it.
Then add volley as a custom agent server in Zed's `settings.json`:

```json
{
  "agent_servers": {
    "Volley": {
      "type": "custom",
      "command": "node",
      "args": [
        "/abs/path/to/volley/dist/cli.js", "acp",
        "--builder-provider", "openrouter", "--builder-model", "anthropic/claude-sonnet-5.5",
        "--critic-provider", "openrouter", "--critic-model", "anthropic/claude-haiku-5.5",
        "--check", "pnpm test"
      ],
      "env": {
        "OPENROUTER_API_KEY": "sk-or-v1-...",
        "PATH": "/usr/local/bin:/usr/bin:/bin"
      }
    }
  }
}
```

`PATH` is there for the builder's commands and the check. Each runs with
`/bin/sh -c`, which reads no shell profile, so a `node` or `pnpm` from nvm, fnm,
volta, or asdf can come back as `command not found` unless it's on this `PATH`.
Put the directories that `dirname "$(command -v node)"` and
`dirname "$(command -v pnpm)"` print at its front.

### Check it in Zed

Run this by hand against a scratch repository with a test command (a
`package.json` whose `test` script runs `node --test` is enough), using the
snippet above. Start a thread with "Volley", and stay in Manual unless a step
says otherwise:

1. Ask for a small change. The builder's work should stream in as the reply,
   under a **Round 1** line.
2. When it edits a file, a permission request should show the diff. Allow it,
   and the card should keep the diff.
3. When it runs a command, a permission request should show the command before
   it runs, and once allowed, the card should show the output.
4. Once the builder finishes, the check should ask, then run as a command card
   titled `pnpm test`, with its output.
5. The critic's verdict should show as a thought.
6. The turn should end with the summary: whether it converged, in how many
   rounds, and the last verdict.
7. Ask it to run `sleep 60`, allow it, and press stop. The turn should end as
   cancelled, and `pgrep -fl 'sleep 60'` should find nothing.
8. Open the mode picker. It should list Manual and Accept edits, and no Auto,
   since volley runs uncontained. Switch to Accept edits and ask for another
   change. The edits shouldn't ask, but a command still should.

Two more round it out. Ask it to run `echo "key=$OPENROUTER_API_KEY"`, and the
output should be `key=` with nothing after it. And the repository should hold no
`.volley`.

## What the builder changed

A check that exits 0 proves the check passed. It does not prove the builder did
the work — a builder can also pass by editing the test. So every iteration,
volley diffs the build root against a baseline captured before the first
iteration and reports what moved:

- The **critic prompt** carries the changed-path list, so the critic reviews the
  change instead of re-reading a tree the check already blessed. Paths and
  statuses only, never diff hunks — the list stays bounded for a local critic
  with a small context window, which can read any file it wants once it knows
  which ones moved.
- Changed paths matching the **gate** — the tests, fixtures, and check
  configuration that decide whether the work passes — are called out separately
  in the prompt, listed in `.volley/summary.json` as `comparison.gate_edits`,
  and warned about on stderr as they happen.

A gate edit is not misconduct: plenty of tasks are *about* the tests. It is the
fact that makes a green check prove less, so volley reports it by default rather
than refusing it. To refuse it, `--fail-on-gate-edit` halts the run on the spot
with exit 8 — success does not override it, because the pass is the thing the
edit puts in question.

The default gate is a broad, language-general list (`*.test.*`, `test/**`,
`fixtures/**`, `vitest.config.*`, `package.json`, `.github/workflows/**`, and
similar). `--gate-paths 'schema/**,docs/spec.md'` (or `gate_paths` in a config
file) **replaces** it — a task that owns its tests should say so — and an empty
list turns the report off entirely.

```sh
# The tests are the spec here: refuse a builder that edits them.
volley --prompt "@task.md" --workspace ./my-project --criteria "@criteria.md" \
  --fail-on-gate-edit
```

Change detection needs git: it diffs against a baseline commit in the build root
(the worktree under `--worktree`, else the workspace). In a workspace that is not
a git repository there is no baseline, so the section is omitted from the critic
prompt rather than claiming the builder changed nothing — and `--dry-run` warns
that `--fail-on-gate-edit` cannot fire there.

## Run artifacts

By default, everything volley knows lives in the workspace:

```
.volley/
  config.json          # resolved run config (immutable per run)
  summary.json         # run-level usage, cost, status
  trajectory.jsonl     # every fascicle trajectory event (replayable, below)
  feedback.md          # current critic feedback (harness-written)
  verdict              # approved | changes_requested (harness-written)
  iterations/NNN/      # per-iteration archive: feedback, verdict, check artifacts, summary
```

A stale `.volley/` from a previous run is rotated to `.volley.bak.<timestamp>/`.

With `--state-dir <root>` (or `state_dir` in a config file), each run writes the
same files to `<root>/<run id>/` instead, and nothing to the workspace. A
directory per run never needs rotating, and `config.json` records the root.
`volley acp` always works this way, under a root of its own
([Where its state goes](#where-its-state-goes)). `volley matrix` still writes
its sweep to `.volley-matrix/` in the workspace, and a base config's
`state_dir` moves only each seat's run state.

The trajectory replays in fascicle's bundled viewer — the `fascicle-viewer` bin
ships inside the `fascicle` package; there is no separate viewer package:

```sh
pnpm dlx --package=fascicle fascicle-viewer .volley/trajectory.jsonl
pnpm dlx --package=fascicle fascicle-viewer <root>/<run id>/trajectory.jsonl   # under --state-dir
```

## Environment variables

See [.env.example](./.env.example): `VOLLEY_CLAUDE_BIN`, `VOLLEY_AUTH_MODE`,
`VOLLEY_LOG_LEVEL`, `VOLLEY_NO_COLOR`, `VOLLEY_PRICING_PATH`, the
`ANTHROPIC_API_KEY` billing-meter warning, each seat's base URL
(`VOLLEY_OLLAMA_URL`, `VOLLEY_LMSTUDIO_URL`, `VOLLEY_OPENROUTER_URL`), and
`OPENROUTER_API_KEY` for [OpenRouter](#openrouter) seats. `volley acp` also
reads `XDG_STATE_HOME` for its state root.

## Development

```sh
pnpm install
pnpm test          # vitest
pnpm typecheck     # tsc --noEmit
pnpm check         # checkride — volley dogfoods its own definition of done
pnpm build         # tsdown → dist/
pnpm diagram       # draw the flow from src/flow.ts with describe.diagram
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

volley is a deliberate sibling to
[ridgeline](https://github.com/robmclarty/ridgeline), not a replacement. ridgeline
fixes plan/build/evaluate as three phases with strong context boundaries;
volley collapses planning into the builder's autonomy and makes evaluation
fully pluggable. Same substrate (fascicle), different opinions.

## License

[Apache 2.0](./LICENSE)
