# volley — Specification (v3, draft for Fable refinement)

A CLI harness that runs a builder/critic loop until a task passes both a deterministic check pipeline and a natural-language acceptance review.

This document supersedes [volley-spec-v2.md](./volley-spec-v2.md), which is retained unchanged for historical reference. v2 respecified volley on the fascicle + checkride substrates and made the **critic** role provider-pluggable (the read-only, schema-constrained critic can run on a local model via `ollama`/`lmstudio`). v3 extends the same seam to the **builder** role: a builder that runs as a volley-driven agentic tool loop on a local model, contained in a disposable sandbox, so that a fully-local configuration can be run and compared head-to-head against the all-Claude configuration.

---

## Note to the Fable refinement pass

This draft is deliberately unfinished in specific, marked ways. It captures a set of **locked decisions** (from the author, non-negotiable) and a set of **open design points** (yours to resolve or sharpen). Your job is to turn this into a v3 that reads with the same authority and internal consistency as v2 — not to relitigate the locked decisions, but to make the design around them coherent, minimal, and honest about its failure modes.

Where to push hardest:

- **§3 (encapsulation).** The Docker-sandbox + git-worktree design has three plausible shapes (container-wraps-harness, harness-execs-into-container, user-provides-devcontainer). Pick one as the specified default and justify it; demote the others to alternatives. The security argument is the load-bearing part — a local builder gets a real `bash` tool, which is exactly the write+exec surface the v2 critic was praised for *not* having. The containment story has to carry that weight.
- **§4 (builder tool surface).** The tool set is enumerated but the exact schemas, caps, and error semantics want the same rigor `src/critic/tools.ts` already has. Reuse `contain()` where path-scoping is the boundary; be explicit about where `bash` makes path-scoping meaningless and the container/worktree becomes the only boundary.
- **§5 (termination).** Both `max_steps` and an explicit `finish` tool are locked. Specify precisely what a `max_steps` cutoff *means* for the loop (partial work handed to check+critic? a distinct exit status?) and how the `finish` tool's payload is used, if at all.
- **§6 (fetch/search).** The prior art is now sourced (a dispatched research brief with primary citations), so this section is more settled than the others — the remaining work is *decisions*, not research: ship `web_search` or defer it, pin the HTML→markdown dependency (native vs hosted reader), and reconcile with the ambient Firecrawl tooling. Re-confirm the version-specific sharp edges (Ollama's tool-serialization bug, Qwen3-Coder's distinct dialect) against whatever runtime/model §8 pins.
- **§8 (comparison).** The whole point is a fair all-local vs all-Claude comparison. Sharpen what "fair" means and what exactly gets measured, so the learning outcomes in §10 are falsifiable.

Everything already true in v2 (loop shape, critic role, checkride gate, cost accounting, exit codes, fresh-context-per-iteration) carries forward unchanged unless a section below says otherwise. Do not re-derive it; reference v2 §N.

---

## Revision notes — what changed from v2

| Area | v2 | v3 |
|---|---|---|
| Builder transport | Always `claude_cli` (full agentic Claude Code session; CLI owns its tool loop) | `claude_cli` **or** a local provider (`ollama`/`lmstudio`). On a local provider the builder is a **volley-driven agentic tool loop** — fascicle runs the tool-call loop; volley supplies the tools. |
| Builder tools | CLI built-ins (`Read/Write/Edit/MultiEdit/Bash/Grep/Glob/WebFetch`), pre-approved via allowlist | On local providers, a volley-supplied tool set: read/write/`bash`/`fetch`/(optional)`web_search`/`finish`. On `claude_cli`, unchanged. |
| Builder termination | The CLI session ends itself; `max_steps` is ignored by `claude_cli` | On local providers: `max_steps` cap **and** an explicit `finish` tool (both — belt and suspenders). On `claude_cli`, unchanged. |
| Isolation | `--git` checkpoints (optional), no sandbox for the builder | **Docker sandbox + git worktree** as the containment boundary for the local builder's `bash`. Resolves v2 open questions §13.3 (multi-provider roles) and §13.4 (sandboxed builder). |
| Web access | `WebFetch` (CLI built-in), single-URL only | A volley `fetch` tool gives local builders single-URL retrieval; an optional `web_search` tool gives open-ended discovery (neither exists for the CLI builder, which keeps `WebFetch`). |
| Provider policy | Anthropic-only by policy; local providers allowed for the critic only | Local providers allowed for **both** roles. Two blessed reference configs: **all-Claude** and **all-local**, designed to be compared. |
| Config surface | `critic_provider` | `builder_provider` added (mechanical plumbing already landed — see §11); new builder-loop and sandbox flags specified in §7. |

The v2 sibling narrative holds: ridgeline validated multi-provider roles with worktree-scoped tools on the same substrate. v3 is volley walking through the door v2 §13.3 left open.

## §1 — Motivation

Two forces motivate v3.

**Cost and sovereignty.** v2 §4 already absorbed the post-2026-06-15 billing reality: unattended loops are metered even for subscription users. The local critic (v0.2) cut the recurring per-iteration critic spend to zero. The builder is the larger and more variable cost — and the half a user most wants to run on hardware they own, with no data leaving the machine. A local builder makes a genuinely $0, fully-offline volley run possible.

**Comparison as a first-class goal.** The author does not expect a local builder to match Claude Code on a whole multi-phase build. The explicit intent (locked) is narrower and more useful: run **one volley invocation per *phase*** of a larger build, and be able to run that phase all-local or all-Claude and **compare the difference** — iteration count, wall-clock, cost, final quality, where the local model gets stuck. volley becomes an instrument for measuring the local-vs-frontier gap on real, bounded work, not a bet that the gap is already closed.

This reframes the capability bar. A local builder does not need to be good enough to trust unattended on an open-ended task. It needs to be good enough to make the comparison informative, and contained enough to be safe to run repeatedly.

## §2 — Solution Overview

### The asymmetry v3 has to close

The v2 critic localized cheaply because it is single-shot, read-only, and schema-terminated: one `generate` call, three read-only tools (`src/critic/tools.ts`), and it ends by emitting the verdict schema. The builder is the opposite on every axis — it writes files, runs commands, and ends only when it decides it is done. A local model brings **no built-in tools**, so volley must supply the entire agentic surface the Claude CLI otherwise provides.

The substrate already supports this. fascicle's `engine.generate` drives a full multi-step tool loop for API providers: `tools: Tool[]`, a `max_steps` bound, a returned `steps: StepRecord[]`, and a `finish_reason: FinishReason` whose values include `'tool_calls'`, `'stop'`, and `'max_steps'`, with `tool_error_policy` governing how a throwing tool is fed back to the model. The read-only critic already exercises this exact path with a smaller tool set. v3 is a larger tool set, a real termination story, and a containment boundary — not a new execution model.

### Roles (v3)

**Builder — `claude_cli` (unchanged from v2 §2).** One `generate` call = one complete agentic Claude Code session, `default_cwd` = the workspace, CLI built-in tools, CLI owns its own step budget.

**Builder — local (`ollama`/`lmstudio`, new).** One `generate` call = one volley-driven agentic tool loop against the local model, bounded by `max_steps`, terminated by the model calling the `finish` tool or by hitting the step cap. Tools are volley-supplied (§4). The loop runs against a **git worktree inside a Docker sandbox** (§3); the `bash` tool is the builder's general-purpose actuator.

**Critic (unchanged from v2).** Read-only, schema-constrained, `claude_cli` or local. Nothing in v3 changes the critic; the all-local config simply selects a local `critic_provider` alongside a local `builder_provider`.

### Loop shape (unchanged)

The outer loop is still fascicle's `loop` (v2 §2, §6): build → check → critique → record, guarded by acceptance ∨ cost-cap ∨ max-rounds. v3 changes only what happens *inside* the build step when `builder_provider` is local. The guard, the check runner, the cost accounting, the archival layout, and fresh-context-per-iteration are all as v2 specifies.

> **Fable:** confirm the inner builder loop is fully contained within one `generate` call and therefore does not perturb the outer `loop`'s carry-state or round accounting. The cost accumulator (v2 §6) folds `result.usage`/`result.cost` per phase regardless of provider; a local builder reports `engine_derived` cost (or `null` when unpriced), never `provider_reported`. State that explicitly so the summary schema stays honest.

## §3 — Encapsulation and isolation (LOCKED intent, OPEN shape)

**Locked:** the whole harness runs contained in a **Docker sandbox**, and the builder operates in a **git worktree**, using "the optimal encapsulation with docker sandbox and/or git worktrees." A local builder is handed a real `bash` tool; the sandbox + worktree is the boundary that makes that safe and its effects disposable.

**Why the boundary has to move.** v2 earned its safety story by giving the critic *no write path and no exec path* — containment was achieved by tool absence (v2 §4). A `bash` tool erases that: any path-scoping check in a tool's `execute` (the `contain()` guard in `src/critic/tools.ts`) is trivially bypassed by `bash -c 'cat /etc/passwd'`. So for the local builder, **the container and the worktree are the containment boundary, not the tool schemas.** The read/write tools still use `contain()` for good-citizen ergonomics and clear errors, but the security guarantee is the sandbox.

### Two isolation layers, two jobs

1. **Git worktree — isolates *effects*.** Each run operates in a dedicated worktree of the target repo, so the builder's writes are a branch that can be diffed, checkpointed per phase (extends v2 `--git`), and discarded wholesale if the phase is abandoned. This is the natural home for the "one volley per phase" model (§1): a phase = a worktree = a branch.
2. **Docker sandbox — isolates *blast radius*.** The `bash` tool runs inside a container with the worktree mounted, so a runaway or adversarial command cannot touch the host filesystem, exfiltrate over an unrestricted network, or exhaust host resources. Network policy, CPU/memory limits, and additional writable mounts are container config.

These compose: the worktree is what the container mounts.

### Three candidate shapes — Fable picks one

> **Fable:** choose a specified default and justify it against the "one volley per phase, run repeatedly, compare configs" workflow. The others become documented alternatives, not equal options.

- **(A) Container wraps the whole harness.** volley (Node process, model client, tools) runs *inside* the container; the worktree is the container's working dir. Simplest mental model, strongest isolation, but the container needs the ollama/lmstudio endpoint reachable (host networking or a sidecar) and needs `checkride`'s toolchain installed inside it.
- **(B) Harness on host, `bash` execs into a container.** volley runs on the host; only the `bash` tool's commands run via `docker exec` (or a persistent `docker run` session) against a container that mounts the worktree. Keeps the model client and Node on the host (easy ollama access), contains only the dangerous surface. More moving parts; the write tools and the `bash` tool now act on the same files through two different paths (host FS vs container FS) and must agree.
- **(C) User-provided devcontainer.** volley assumes it is *already* running inside a sandbox (devcontainer/CI container) and only manages the worktree. Zero Docker orchestration in volley; punts the boundary to the operator. Weakest guarantee, smallest lift, most honest about "this is an experiment you run deliberately."

**Author lean (non-binding):** the "run repeatedly to compare" workflow favors low per-run friction, which argues for (B) or (C); the "real containment for a real `bash` tool" requirement argues for (A) or (B). (B) is the likely synthesis — Fable, pressure-test that.

### Relationship to fascicle's existing sandbox

fascicle's `claude_cli` provider already has a `sandbox` config (`bwrap`/`greywall`, network allowlist, extra write paths) — that is v2 §13.4, and it only covers the **CLI builder**. The local builder is not a CLI subprocess, so it cannot use that path; it needs volley's own container boundary. Fable should state the parallel and note that a hardened all-Claude run and a hardened all-local run reach containment by two different mechanisms (fascicle `sandbox` vs volley Docker), which is a wrinkle for "fair comparison" (§8).

### Installation

**Locked:** "install and use docker sandbox." v3 introduces a Docker dependency for the local-builder path only. The all-Claude path must not require Docker. Fable: specify detection/bootstrap (does volley build/pull an image? ship a `Dockerfile`? require the user to provide an image tag?) and the `--dry-run` preflight (mirror v2's `checkride doctor`: a `docker` availability + image check before any model spend).

## §4 — Builder tool surface for local models (OPEN — needs the §-13-critic-tools treatment)

When `builder_provider` is local, volley passes `tools: builder_tools(ctx)` into `generate`, mirroring how the critic passes `tools: read_only_tools(workspace)`. The set:

| Tool | Purpose | Boundary |
|---|---|---|
| `read_file`, `search_files`, `list_files` | Reuse `src/critic/tools.ts` verbatim. | `contain()` path-scoping. |
| `write_file` | Create/overwrite a workspace file. | `contain()`; byte cap. |
| `edit_file` | String-replace edit (semantics of the CLI `Edit`: unique old-string → new-string). | `contain()`. |
| `bash` | Run a shell command in the worktree; capture stdout/stderr/exit; timeout; output byte cap. The general actuator — build, test, move files, run `pnpm check`. | **Container + worktree (§3), not path-scoping.** |
| `fetch` | Retrieve a single URL as clean markdown (§6). | Network policy of the sandbox; byte cap. |
| `web_search` (optional) | Open-ended search returning ranked `{title,url,snippet}` (§6). | Backend + sandbox network policy. |
| `finish` | Signal the builder is done; carries a short summary/among reason (§5). | — |

> **Fable:** give each new tool the same rigor `src/critic/tools.ts` already shows — zod `input_schema`, explicit caps (`READ_FILE_MAX_BYTES`, `SEARCH_MAX_MATCHES`, etc. have obvious `bash`/`fetch` analogues: `BASH_TIMEOUT_MS`, `BASH_MAX_OUTPUT_BYTES`, `FETCH_MAX_BYTES`), and a `tool_error_policy` stance (does a non-zero `bash` exit *throw* — feeding an error back to the model — or *return* the captured failure as a normal result? The latter is almost certainly right: a failing test is signal the builder should read, not a harness error). Decide whether `write_file`/`edit_file` act on the host FS or inside the container under shape (B), and how they stay consistent with `bash`.

**Do not** reuse the builder's `claude_cli` system prompt for the local path. It assumes CLI semantics ("the current working directory", implicit `Bash`/`WebFetch`). The local builder needs a `harness_append_local`-style system prompt (compare `src/critic/presets/harness_append_local.md`) that enumerates the volley-supplied tools, states the worktree is the working directory, and states the `finish` convention. Fable: draft it.

## §5 — Termination (LOCKED: both)

**Locked:** the local builder loop terminates on **both** a `max_steps` cap **and** an explicit `finish` tool. Neither alone:

- `max_steps` alone → the model burns the whole budget every iteration even when it finished early; wasteful and noisy.
- `finish` alone → a model that never calls it (or loops) runs unbounded; unacceptable for an unattended, metered-or-not loop.

Together: the model calls `finish` when done (fast path); `max_steps` is the hard backstop.

> **Fable, specify:**
> - What `max_steps` defaults to, whether it is per-iteration, and the config/env surface (`--builder-max-steps`? `VOLLEY_BUILDER_MAX_STEPS`?).
> - What a `max_steps` cutoff *means* downstream. Recommended: it is **not** an error — the (partial) worktree is handed to the check + critic exactly as a `finish`-terminated iteration would be; the critic sees incomplete work and requests changes; the loop continues. `finish_reason: 'max_steps'` is surfaced as a warning line and recorded in the iteration summary, so a run that keeps hitting the cap is visible. This preserves v2's "non-convergence is data, not an exception."
> - Whether `finish`'s payload (a summary string? a self-assessment?) is used by the harness or purely advisory. v2's builder returns nothing structured; simplest is that `finish` takes a short `summary` string that volley logs to the trajectory and otherwise ignores — the workspace, not the builder's self-report, is the source of truth (mirrors the critic contract where the harness trusts the files, not the prose).
> - Interaction with `tool_error_policy` and fascicle's `schema_repair_attempts`: a local model that emits a malformed tool call should be retried/repaired, not crash the phase (exit 3). Confirm fascicle's behavior and state it.

## §6 — Local `fetch` and `web_search` (PRIOR ART — sourced 2024–2026)

**Locked:** implement a local `fetch` tool; research how others solved this, especially with Qwen. The findings below come from a dispatched research brief with primary-source citations (Qwen/Ollama/LM Studio docs, GitHub issues, the reference MCP fetch server). They are sourced, not speculative — but pin them against the *specific runtime and model build* the all-local config selects (§8) at implementation time, because the sharp edges here are version-specific.

### The problem

Local models on `ollama`/`lmstudio` speak the OpenAI-compatible `tools` array (function calling), which fascicle's tool bridge already targets. So the *plumbing* to expose a `fetch` tool is identical to the critic's read tools. The hard parts are (a) Qwen's tool-calling reliability on local runtimes, (b) turning arbitrary HTML into token-cheap text, and (c) whether to also offer open-ended search and with what backend.

### Qwen tool-calling — one format on the wire, Hermes underneath

Qwen3 accepts the standard **OpenAI-compatible `tools` array**; its baked-in chat template renders tools Hermes-style and expects tool calls back wrapped in `<tool_call>{"name":…,"arguments":{…}}</tool_call>`, which the runtime re-parses into an OpenAI-shaped `tool_calls` array. Load-bearing caveats for volley:

- **Qwen's own docs do not guarantee protocol adherence** even with correct templates — parse defensively and repair. This is exactly what fascicle's `schema_repair_attempts` + a return-not-throw `tool_error_policy` (§4) buy: a malformed tool call is fed back as an error the model retries, not a phase crash.
- **Ollama has documented tool-serialization bugs** (ollama/ollama#14601: tool defs serialized as Go-struct strings instead of JSON; prior tool-call turns stripped from history; #14493: tool calling non-functional on some Qwen builds). The community fallback is to **bypass the `tools` param and embed the Hermes-format schemas directly in the system prompt.** volley should treat this as a real contingency for the ollama path.
- **LM Studio's parser is generally cleaner for Qwen** than Ollama's Go-template path (`http://localhost:1234/v1`, standard `tools`/`tool_calls`). This is a point in favor of `lmstudio` as the *default* local builder transport, even though `ollama` is the more common install.
- **Model choice matters more than size, and Qwen3-Coder is a trap for the generic parser:** Qwen3-Coder was trained on a *different* tool-call dialect (`<function=name><parameter=…>…</function>`, parser `qwen3_coder`) — mixing it with the Hermes parser silently drops tool calls. Sub-7B models are widely reported unreliable for tool loops. This constrains §8's pinned model: pick a build whose dialect matches the runtime's parser, prefer ≥8B, and if code/tool-heavy, Qwen3-Coder-30B *with its matching parser*.
- **One tool call per turn** is the safe default; parallel tool calls are the shakiest path. Reinforces the §5 step-cap posture.

### `fetch` — GET → extract → markdown → truncate/paginate

The universal pipeline. HTML→clean-markdown options, smallest-footprint first for Node/TS:

- **Native (recommended default):** `@mozilla/readability` (isolate the article) fed a DOM from **`linkedom`** (far lighter/faster than `jsdom`) → **`turndown`** (→ markdown). Three deps, no headless browser. Mirror the **reference MCP fetch server's contract**: `fetch(url, max_chars, start_index)` returning a truncated slice with a `"…[truncated, call again with start_index=N]"` marker so the model can page — same ergonomics as `read_file`'s byte-cap marker in `src/critic/tools.ts`.
- **Zero-local-parsing alternative:** delegate extraction to a hosted reader — Jina Reader (`https://r.jina.ai/<url>` → markdown) or Ollama's own `web_fetch` (`{title,content,links}`) — making the tool a plain HTTP call. Leanest code, but adds a network dependency, which fights the "fully offline" all-local goal.
- **Token math:** markdown is ~5–10× cheaper than raw HTML; **never return raw HTML**, cap hard at `FETCH_MAX_BYTES`.

Biggest failure modes to handle explicitly: (1) **JS-rendered SPAs** yield empty extraction — detect short output, fall back to raw-ish text; (2) **token blowup** — hard cap; (3) **SSRF** — the tool can reach `localhost`/internal IPs, so deny private ranges (the MCP server ships the same warning); (4) non-HTML content types (PDF/JSON), redirects, encodings; (5) paywall/bot-wall boilerplate.

### `web_search` — pick one backend, hide it behind the tool

| Backend | Truly local / free? | Notes |
|---|---|---|
| **SearXNG** | ✅ self-hosted, no per-call fee | Must enable `format: json` in `settings.yml` (**403 otherwise**); `GET /search?q=…&format=json`. Owns its ops + upstream rate limits. The pick for a genuinely-local all-local config. |
| **Tavily** | hosted, 1k/mo free | Returns cleaned **content + an answer**, so no separate hydration step. Near-zero setup. |
| **Ollama `web_search`** | hosted-but-free w/ Cloud key | `POST /api/web_search`, `{query,max_results}` → `{title,url,content}`. |
| **Brave / Serper / Exa** | hosted, keyed | Serper is snippet-only (pair with a reader). |
| **DuckDuckGo (`ddgs`)** | free, no key | **Avoid in production** — pervasive `202` rate-limiting across Open WebUI/Dify/Langflow. |

Uniform return shape `{title, url, snippet}`; snippet-only backends need a follow-up `fetch` to hydrate the top 1–3 (Tavily/Ollama return content inline, skipping that round-trip).

### MCP vs native

The reference MCP `fetch` server and MCP search servers (Brave/Tavily/SearXNG) exist, but **local models don't speak MCP natively** — they need a bridge (`qwen-agent`, LM Studio's MCP client, `mcp-client-for-ollama`). For volley, a **native tool** (readability+linkedom+turndown, or an HTTP reader) is a smaller dependency footprint and matches exactly how `src/critic/tools.ts` is already built. Recommend native; treat MCP as out of scope unless a compelling reason appears.

### Design recommendation (for Fable to lock)

- **`fetch`** ships in v3. Native, `@mozilla/readability` + `linkedom` + `turndown`, MCP-fetch-style `{url, max_chars?, start_index?}` contract, SSRF deny-list, hard byte cap. Routed through the §3 sandbox network policy.
- **`web_search`** — Fable decides ship-vs-defer. If it ships: off by default, backend by env, default **SearXNG** (keeps all-local truly local) with **Tavily** as the keyed convenience path; **never** raw DuckDuckGo. A fully-offline run must disable both web tools cleanly (network policy in §3).

> **Fable:** (1) lock `web_search` in or out for v3; (2) confirm `linkedom`+`readability`+`turndown` against the current versions, or choose the hosted-reader path and accept the network dependency; (3) reconcile with the ambient **Firecrawl** tooling in this environment — dependency, optional backend, or out of scope; (4) state the SSRF/private-IP policy normatively.

## §7 — Config and CLI surface

### Already landed (mechanical plumbing — see §11)

`builder_provider: 'claude_cli' | 'ollama' | 'lmstudio'` exists end-to-end: `VolleyConfig`/`ResolvedConfig` (`src/types.ts`), resolution + validation (`src/config.ts`, default `claude_cli`), `--builder-provider` flag (`src/cli.ts`), engine wiring for either role's local provider (`src/engine.ts`), persisted to `.volley/config.json` and restored on `resume` (`src/workspace.ts`, `src/iteration.ts`). Setting it today is inert for execution — `src/builder.ts` still hardwires `provider: 'claude_cli'` — which is the intended landing zone for §4–§5.

### New surface to specify (Fable)

| Flag / env | Governs | Notes |
|---|---|---|
| `--builder-max-steps` / `VOLLEY_BUILDER_MAX_STEPS` | Local builder loop bound (§5) | Ignored for `claude_cli`. |
| `--sandbox` / sandbox config | Docker containment (§3) | Required for local builder; forbidden/no-op for claude_cli, or maps to fascicle `sandbox`? Fable decides. |
| `--worktree` / worktree config | Git worktree isolation (§3) | Interaction with existing `--git` checkpoints. |
| `VOLLEY_OLLAMA_URL` / `VOLLEY_LMSTUDIO_URL` | Local provider endpoints | **Already exist** (`src/engine.ts`), reused for the builder. |
| web-tool backend env | `fetch`/`web_search` (§6) | e.g. `VOLLEY_SEARCH_BACKEND`, `VOLLEY_SEARXNG_URL`. |

Follow v2's rule: local defaults come from env with localhost fallbacks; the ai-sdk peer is loaded lazily by fascicle only when the provider runs (already true).

## §8 — The two comparison configurations (LOCKED goal)

**Locked:** a real, working **all-local** example and a real **all-Claude** example, built to be compared — same for the critic (all-Claude critic vs all-local critic). This is the deliverable that proves v3.

- **all-Claude** — `builder_provider: claude_cli`, `critic_provider: claude_cli` (today's default). The frontier baseline.
- **all-local** — `builder_provider: ollama` (e.g. `qwen3:32b`), `critic_provider: ollama`, `check: checkride`, Docker sandbox + worktree, `fetch` enabled. $0, offline.
- The existing `examples/local-critic/` (Claude builder + local critic) remains as the mixed midpoint.

Both examples run the **same phase-sized task** with the **same criteria and the same checkride gate**, so the only variable is provider.

> **Fable, sharpen "fair":**
> - Same task, criteria, check, `max_iterations`, `max_cost_usd`. Only the provider differs.
> - What gets measured (the run already records most of it in `.volley/summary.json`): iterations to converge (or non-convergence), wall-clock, cost (all-local ≈ $0), final verdict, and the check pass/fail trajectory. Add whatever the comparison needs that the summary doesn't already carry.
> - Confounds to name honestly: the containment mechanisms differ (fascicle `sandbox` vs volley Docker, §3); the builder tool surfaces differ (CLI built-ins vs volley tools, §4); `fetch`≠`WebFetch`. A "fair" comparison controls the task, not the machinery — say so.
> - Pick the pinned local model and task in the example so the comparison is reproducible, not aspirational.

## §9 — checkride under a local builder (LOCKED: use checkride)

**Locked:** the check stays checkride. This constrains §3–§4: the local builder must be able to run `pnpm check` (checkride) itself, which it can only do through the `bash` tool inside a container that has the workspace's pnpm toolchain installed. So:

- The `bash` tool is **required** for the local-builder + checkride combination (it is how the builder self-verifies, per the v2 §6 builder prompt stanza, and how the harness gate runs).
- The container image (§3) must contain node/pnpm and the workspace's dev tools, or mount them. Fable: specify.
- The v2 double-run open question (§13.2 — builder self-runs `pnpm check`, then the gate runs it again) is *worse* on slow local hardware inside a container. Fable: decide whether v3 adopts the "verify a fresh `.check/summary.json` instead of recomputing" fix now, or documents it as a known cost of the all-local path.

## §10 — Failure modes (new; extends v2 §9)

Fable: fold these into the v2 §9 table with concrete verifications.

| Scenario | Expected behavior |
|---|---|
| `builder_provider: ollama` but the ollama endpoint is unreachable | Provider error → exit 3, phase+iteration named (same as a claude_cli startup failure). `--dry-run` should catch it. |
| Local builder hits `max_steps` without calling `finish` | Not an error (§5): partial worktree → check + critic → loop continues; warning + `finish_reason: 'max_steps'` recorded. |
| Local model emits a malformed tool call | fascicle repair/retry; only a persistent failure is a builder error (exit 3). Confirm fascicle behavior. |
| `bash` command times out / floods output | Truncated at the byte cap, timeout returned as a normal tool result the model can read; the *run* does not fail. |
| Docker unavailable / image missing (local builder) | Config/preflight error → exit 5 (mirror `checkride doctor`), before any model spend. Never on the all-Claude path. |
| `fetch`/`web_search` blocked by sandbox network policy | Error surfaced to the model as a tool result (not swallowed); run continues. A fully-offline run disables both tools cleanly. |
| Worktree already exists / dirty | Fable: specify — reuse, refuse, or rotate (compare v2's `.volley.bak` rotation). |

## §11 — Implementation status

**Landed on branch `local-builder` (this revision):** the mechanical config/type plumbing only.

- `BuilderProvider` type and `builder_provider` field threaded through `src/types.ts`, `src/config.ts` (default `claude_cli`, enum validation with a `--builder-provider` error), `src/cli.ts` (flag + `merge_flags` + dry-run display), `src/engine.ts` (generalized so a local provider selected by **either** role is wired once), `src/orchestrator.ts` (passes `builder_provider` to the engine), `src/workspace.ts` (persists it), `src/iteration.ts` (restores it on resume, defaulting to `claude_cli`).
- Tests mirror the critic-provider coverage (`test/unit/config.test.ts`); `test/helpers/harness.ts` default updated. Full suite green, typecheck clean, oxlint clean.
- **Deliberately not done** (this is the §4–§6 work): `src/builder.ts` still hardwires `provider: 'claude_cli'`; there is no `builder_tools`, no `bash`/`fetch`/`web_search`/`finish` tool, no `max_steps` wiring, no Docker/worktree orchestration, no `harness_append_local` builder prompt, no examples. Setting `builder_provider` to a local value today wires the provider into the engine but does not change builder execution.

The remaining work attaches at exactly two seams: `run_builder` in `src/builder.ts` (branch on `config.builder_provider` the way `critic_tool_options` branches on `config.critic_provider` in `src/critic/run.ts`) and a new `src/builder/tools.ts` (sibling to `src/critic/tools.ts`).

## §12 — Open questions for the Fable pass

1. **§3 shape.** Which of container-wraps-harness / harness-execs-into-container / user-devcontainer is the specified default? (Author leans B; justify or overturn.)
2. **§4 host-vs-container FS.** Under shape (B), do `write_file`/`edit_file` write host-side or container-side, and how do they stay consistent with `bash`?
3. **§4 `tool_error_policy`.** Does a non-zero `bash` exit throw or return? (Recommend: return.) Same question for `fetch` HTTP errors.
4. **§5 `max_steps` semantics.** Confirm the "partial work → check+critic, not an error" model and the config/env surface.
5. **§6 `web_search` in or out?** Ship it in v3 or defer? Which default backend keeps "all-local" truly local? Reconcile with the ambient Firecrawl tooling.
6. **§6 conversion dependency.** Pin the HTML→markdown path with the smallest footprint; confirm Qwen tool-calling reliability on the pinned runtime.
7. **§8 fairness.** Nail the controlled variables and the confound disclosures so the comparison is scientifically honest.
8. **§9 double-run.** Adopt the artifact-verification fix now, or document the double `pnpm check` as a known all-local cost?
9. **Cost/priced-model.** A local builder's cost is `engine_derived` or `null`; confirm the summary schema and the cap logic (v2 §6) behave sensibly when a phase costs `$0`/`null`.
10. **Fresh context vs. the inner loop.** v2's fresh-context-per-iteration is about the *outer* loop. Confirm the *inner* local-builder tool loop's step history stays within the single `generate` call and is discarded between iterations, preserving the v2 hygiene guarantee.

---

*Draft status: locked decisions are marked LOCKED and must survive refinement; everything else is yours to resolve. Verify all §6 citations before they enter the normative text. When you promote this to the working v3, delete this note and the "Note to the Fable refinement pass" block, and fold §10–§12 into the v2-style §9/§13 structure.*
