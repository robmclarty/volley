# v3 finding — all-Claude vs all-local (model vs transport)

*Verification §4 of the v3 finish (plumbbob step 16). Both blessed examples ran
the same phase-sized task, criteria, checkride gate, and caps; this write-up
records where the local model got stuck, whether it was the model or the
transport, and the confounds that keep that answer honest. Numbers quote each
arm's `.volley/summary.json` `comparison` block (run state is gitignored, so the
blocks are reproduced here).*

## The experiment

One task, two arms:

> Create `src/slug.ts` exporting `slugify(text: string): string` — lowercase,
> trim, collapse runs of whitespace and punctuation to single hyphens, and strip
> diacritics — plus a Vitest test `src/slug.test.ts` covering the behavior and
> edge cases.

Both arms gate on the same `checkride.config.json` (types via `tsc`, test via
`vitest`), the same `reviewer` critic criteria, `max_iterations: 6`,
`max_cost_usd: 10`. The workspaces start byte-identical but for naming: README,
checkride config, and a pinned toolchain manifest (checkride 0.4.1, typescript
7.0.2, vitest 4.1.10) — no tsconfig, no vitest config, no source. Creating
whatever the gate needs is part of the task.

| | all-Claude | all-local |
|---|---|---|
| builder + critic | `claude_cli` / sonnet | `ollama` / qwen3.6:latest (36B Q4) |
| transport | `claude_cli` (CLI subprocess) | `ai_sdk` (fascicle → `ai-sdk-ollama`) |
| containment | host, no Docker (C4/D10) | hardened Docker sandbox (B′/D5) over a per-run git worktree (s2 D3) |
| tool surface | Claude Code's own tools | volley's tools (`bash`, file tools, `fetch`) |
| cost meter | real Claude tokens | $0 target |

Environment: macOS (Darwin 25.5.0), 34 GB unified memory, Docker Desktop 29.6.1,
Ollama on the host, model pre-warmed (`keep_alive 30m`) before the local run.
The blessed config pins `qwen3:32b`; this run swapped the model at the CLI
(`--builder-model/--critic-model qwen3.6:latest`) to use the machine's proven
local model without editing the example.

## Result: all-Claude arm

Converged **first iteration, cold** (workspace reset to pristine before the run):

```json
{
  "builder_transport": "claude_cli",
  "critic_transport": "claude_cli",
  "iterations_to_converge": 1,
  "wall_clock_ms": 145619,
  "total_cost_usd": 0.7734,
  "builder_cost_usd": 0.6688,
  "critic_cost_usd": 0.1046,
  "final_verdict": "approved",
  "check_trajectory": [{ "iteration": 1, "ran": true, "ok": true, "failing_slots": [] }],
  "local_salvage": { "tool_calls": 31, "salvaged_tool_calls": 0, "rate": 0 }
}
```

2m 26s wall clock, $0.77 (subscription meter; ~1.38 M cached input tokens, 7.4 K
output). The builder created `tsconfig.json` and `vitest.config.ts` unprompted,
wrote a clean NFKD-normalize + combining-diacritics-strip `slugify`, 10 test
cases, and passed the check gate on its first try; the critic approved on the
same iteration.

## Result: all-local arm

Three attempts, each cold by construction (a non-success run's worktree is
abandoned and torn down, D13, so nothing carries over). Ollama 0.30.10.

**Attempts 1–2 — the blessed same-model pair (`qwen3.6:latest` builder +
critic): reproducible critic-phase death, 2/2.** Both attempts told the same
story. The builder one-shot the task — wrote a clean NFD-normalize `slugify`
plus **15 test cases** (sonnet wrote 10), ran `pnpm install` and `vitest` itself
to verify (22 tool calls, attempt 1) — and the check gate came back green in the
worktree. Then the critic phase died before producing a verdict:

```
volley: critic failed on iteration 1: stream interrupted:
  XML syntax error on line 3: element <function> closed by </parameter>   (attempt 1)
  XML syntax error on line 4: element <function> closed by </parameter>   (attempt 2)
```

The Ollama server log pins the origin — its own qwen tool-call parsers, not the
client stack:

```
level=WARN source=qwen3coder.go:71 msg="qwen tool call parsing failed"
  error="XML syntax error on line 3: element <function> closed by </parameter>"
level=WARN source=qwen35.go:105 msg="qwen3.5 tool call parsing failed" ...
```

The run still exits with a well-formed `summary.json` (`status: "error"`,
`comparison` block populated, `iterations_to_converge: null`) — the error path
of the summary writer held.

**Attempt 3 — split roles (`qwen3.6:latest` builder, `qwen3:8b` critic):
converged.** Same stack, same tools+schema wiring, only the critic model
swapped:

```json
{
  "builder_transport": "ai_sdk",
  "critic_transport": "ai_sdk",
  "iterations_to_converge": 1,
  "wall_clock_ms": 403399,
  "total_cost_usd": 0,
  "final_verdict": "approved",
  "check_trajectory": [{ "iteration": 1, "ran": true, "ok": true, "failing_slots": [] }],
  "local_salvage": { "tool_calls": 20, "salvaged_tool_calls": 0, "rate": 0 }
}
```

6m 43s wall clock, $0, 83.5 K tokens in / 9.8 K out, one iteration, approved —
the whole loop (builder tool loop → checkride in the worktree → critic verdict
via constrained decode) end-to-end inside the hardened container. **Salvage rate
0**: every one of the builder's 20 tool calls parsed natively through
`ai-sdk-ollama` — the fallback text-recovery layer never fired.

**Attempts 4–5 — the critic-model matrix.** To isolate whether the critic seat
itself, model size, or this one model was the problem, two more runs swapped
only the critic (qwen3.6 builder throughout):

| critic model | size | outcome |
|---|---|---|
| qwen3.6:latest | 23 GB | ✗ 0/2 — fatal tool-XML stream death |
| qwen3:8b | 5.2 GB | ✓ approved (403 s run) |
| gemma4:12b | 7.6 GB | ✓ approved — but ~339 K tokens in / 13 K out (~5× glm) |
| glm-4.7-flash | 19 GB | ✓ approved — 184 s run, 71 K in / 3.4 K out, the most efficient |

Every alternative critic converged, including a 19 GB model — so "a big model
judges" is viable on this stack (Ollama swaps the two large models between
phases; the eviction cost is one reload per phase boundary and the glm run was
still the fastest). The failure isolates to exactly one cell: **qwen3.6 in the
critic seat**. Efficiency varies widely by judge: gemma re-read its way through
5× the context for the same verdict.

### Head-to-head (converged runs)

| | all-Claude (sonnet) | all-local (qwen3.6 + 8b critic) |
|---|---|---|
| iterations to converge | 1 | 1 |
| check trajectory | green first try | green first try |
| wall clock | 2m 26s | 6m 43s (2.8×) |
| cost | $0.77 | $0 |
| builder tool calls | 31 (its own loop) | 20 (volley's loop, 0 salvaged) |
| tests written | 10 | 15 |
| verdict | approved | approved |

## What running the pair actually surfaced: the harness, not the model

The step's question was "where does the local model get stuck?" The loudest
finding is one layer down: **five of the seven defects that blocked the pair
were harness/environment seams that only manifest on first live contact**, and
all of them predate either model doing anything wrong.

1. **The sandbox image didn't build** — `Dockerfile` copied `package.json` +
   `pnpm-lock.yaml` but not `pnpm-workspace.yaml`, whose `allowBuilds` approvals
   pnpm 11 requires (`ERR_PNPM_IGNORED_BUILDS`).
2. **`pnpm exec` talks over its child's stdout** — pnpm 11's dep-verify prints
   `Already up to date` ahead of `checkride --json`'s JSON, killing the parse
   and the entire first all-Claude run (exit 4) *after* the builder had done
   perfect work. Fixed with a tolerant slice-parse + `.check/summary.json`
   fallback. Updating pnpm does not help: latest re-delegates to the
   `packageManager`-pinned version, and the chatter is by design.
3. **The check gated the wrong tree under `--worktree`** — step 8 deferred
   re-pointing the deterministic check to the build root and no later step
   landed it, so the worktree'd local arm could never have converged: the
   builder wrote into the worktree while checkride examined the untouched
   workspace. The kind of defect only an end-to-end live run exposes — every
   unit test of the worktree lifecycle used `check: 'none'`.
4. **A fresh worktree has no `node_modules`** — `git worktree add` checks out
   tracked files only, so the check toolchain vanished from the tree being
   checked. Fixed by symlinking the workspace's install into the worktree at
   creation.
5. **The documented `docker run` line couldn't work** — it mounted the
   workspace itself, leaving the sibling `workspace.worktree` on the read-only
   rootfs (EROFS), didn't mount the config it referenced, and named a `volley
   run` subcommand that doesn't exist. The example now mounts the example dir
   and passes `--workspace` explicitly.

Two environment facts got disclosed rather than fixed: on Docker Desktop
(macOS/Windows) the `DOCKER-USER` chain lives inside the VM, so the L3/L4
default-DROP half of the allowlist posture is Linux-host-only (the bridge,
host-gateway crossing, and the in-process SSRF deny-list all still apply); and
`--memory-swappiness` is discarded on cgroup v2 kernels.

One machine-local confound worth naming because it *looks* like a model
failure: another local-LLM service (lodestar, launched by a leftover
editor-agent session) held Ollama models on a self-refreshing keep-alive lease.
On a 34 GB machine, its 7.4 GB adjudication model evicted the 23 GB qwen3.6
mid-preflight. A local-model harness comparison is only as clean as the
machine's other tenants — check `ollama ps` before believing a timeout.

What live contact *validated*, equally part of the finding: the B′-2 containment
contract behaved exactly as designed at every probe — the `--dry-run` preflight
inside the container reported containment, toolchain, worktree, and endpoint
state truthfully (exit 5 with Ollama down, exit 0 with it up, never exit 5 on
the all-Claude path, C4); `VOLLEY_MODEL_HOST=host.docker.internal` crossed the
loopback base URL through the v0.3.1 normalizer untouched (OQ-8 closed); the
worktree lifecycle created, linked, and tore down cleanly inside the mount; and
the error path of the first crashed run still wrote a well-formed
`summary.json` with its `comparison` block.

## Model vs transport

**The local model did not get stuck on the task.** On a phase-sized task,
qwen3.6 matched sonnet iteration-for-iteration: one-shot builder work, check
green on the first try, more tests than the baseline, zero salvaged tool calls.
The capability gap on this task was wall clock (2.8×) and nothing else.

**It got stuck on the protocol, and only in the critic role.** The critic call
is the one place volley combines a tool surface (workspace-scoped read-only
tools) with a constrained structured verdict (`verdict_schema` → Ollama
constrained decode). Under that combination qwen3.6 reproducibly emits
malformed `<function>…</parameter>` tool-call nesting; Ollama's server-side
qwen parser (`qwen35.go` / `qwen3coder.go`) rejects it and the stream dies.

The attribution splits cleanly in two:

- **The malformed emission is the model's.** `qwen3:8b`, under the *identical*
  transport, tool wiring, and schema, emits parseable calls and completes the
  verdict. The same qwen3.6 emits 20+ well-formed tool calls in the builder
  role, where no constrained verdict is in play — the defect is specific to
  that model under that prompting/decoding combination, not to local models per
  se.
- **The escalation from mistake to fatality is the serving stack's.** volley
  carries a salvage layer built for exactly this failure (recover tool calls
  from malformed assistant text, count them in `local_salvage`) — and it never
  gets the chance, because the parse failure happens *server-side* and arrives
  as a dead stream, not as recoverable text. Any client transport that requests
  tool calls through Ollama's parser shares this failure mode; the documented
  native transport (D2) would hit the same server-side parser. A local-critic
  design that skips server-parsed tool calls (verdict via prompt+parse+repair,
  Q5) would sidestep it — at the cost of the constrained-decode guarantee.

**Practical shape of the answer:** the free local path works end-to-end at $0
inside full containment, at ~1.3–3× the wall clock, *if* the critic seat goes to
a model whose tool-call encoding its server parses cleanly — small (qwen3:8b),
mid (gemma4:12b), and large (glm-4.7-flash) all qualify here; only qwen3.6 does
not. The blessed same-model pair is currently broken by a model×server seam, not
by volley's harness — and the harness's own error path reports it honestly
rather than hanging or corrupting state.

**Follow-ups this opens (parked, not built):** phase-level bounded retry on
provider stream errors (the slip is stochastic — a retry of the same call may
pass); a tool-less critic fallback (the critic already receives criteria + check
artifacts in its prompt, so after repeated tool-phase deaths it could still
render a verdict); and an upstream Ollama report — `qwen35.go` hard-errors the
stream on a parse failure where degrading to plain text would let client-side
salvage layers recover.

## Confounds (disclosed, not narrowed — s2 D9)

- **Containment mechanisms differ by construction** (D10): the CLI arm rides
  `claude_cli`'s own permission model on the host; the local arm rides volley's
  Docker sandbox + worktree. volley deliberately does not harden the CLI via
  fascicle's `claude_cli` bwrap/greywall sandbox, so containment is part of the
  arm, not a controlled variable.
- **Tool surfaces differ**: Claude Code's tools (its `WebFetch`, editor tools,
  its own bash loop) vs volley's `bash`/file tools/`fetch`. `fetch` ≠
  `WebFetch`.
- **Transport is a real second variable**: `claude_cli` subprocess vs `ai_sdk`.
  Both arms *have* an AI-SDK layer in the stack only in the trivial sense that
  fascicle hosts both providers; the CLI arm does not route through it, so
  transport effects are not shared out.
- **The models are not size-peers**: sonnet vs a 36B Q4 local model. The
  comparison asks "what does the free local path cost you in practice," not
  "which model is smarter at equal capability."
- **Cost meters differ in kind**: real tokens vs $0-marginal local compute;
  compare iterations-to-converge, wall clock, and salvage rate, not dollars.
- **Machine tenancy** (above): the local arm shares its host with whatever else
  leases the Ollama daemon.
