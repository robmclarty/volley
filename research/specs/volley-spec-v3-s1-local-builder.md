# volley v3 — Session 1: the local builder tool loop

A plan-ready specification for the first of two v3 build sessions. This session
makes `builder_provider: ollama | lmstudio` actually drive a **volley-supplied
agentic tool loop** on a local model, instead of the current placeholder that
hardwires `claude_cli`. Containment (Docker sandbox + git worktree) is the
**second** session — see [volley-spec-v3-s2-sandbox-worktree.md](./volley-spec-v3-s2-sandbox-worktree.md).

This document supersedes the relevant portions of the v3 refinement draft
([volley-spec-v3.md](./volley-spec-v3.md)), which is retained as the design
rationale. Everything true in [volley-spec-v2.md](./volley-spec-v2.md) — the
outer loop shape, the critic role, the checkride gate, cost accounting, exit
codes, fresh-context-per-iteration — carries forward unchanged unless a
decision below says otherwise; it is referenced, not re-derived.

---

## Frame

**Problem.** volley's builder role can only run as a full `claude_cli` agentic
session. The v0.2 milestone already localized the *critic*; the mechanical
`builder_provider` plumbing has already landed (types, config, CLI flag, engine
wiring, persistence, resume — see "Already landed" below). But `run_builder` in
`src/builder.ts` still hardwires `provider: 'claude_cli'`, so selecting a local
builder provider is inert. A local model brings **no built-in tools**, so volley
must supply the entire agentic surface (read/write/exec/fetch) and its own
termination story.

**Smallest thing that solves it.** A `src/builder/tools.ts` tool set plus a
local branch in `run_builder` that runs one bounded fascicle tool loop per
iteration against the local model, terminated by an explicit `finish` tool or a
`max_steps` backstop. The tools run **on the host, in the workspace directory**
— exactly where the `claude_cli` builder runs today. No Docker, no worktree yet.

**Done when.** With a real local endpoint (ollama or lmstudio) serving a pinned
tool-capable model, `volley` completes a phase-sized task end-to-end through the
volley tool loop — reads files, writes/edits files, runs `pnpm check` via the
`bash` tool, calls `finish` — and the outer loop treats the resulting workspace
identically to a `claude_cli`-built one (check runs, critic critiques, loop
continues or converges). A `max_steps` cutoff is handled as partial work, not an
error. Unit tests cover every new tool; a `VOLLEY_LIVE=1` live test exercises the
real local-provider path.

**Explicitly not doing (this session).**

- No Docker sandbox and no git worktree — that is Session 2. Until Session 2
  lands, the local builder's `bash` runs **unsandboxed on the host**, so it is
  refused by default and requires an explicit opt-out (see Decision 11).
- No `web_search` tool (deferred from v3 entirely — Decision 8).
- No text-protocol (Tier 2) transport — native + salvage only (Decision 5); the
  loop is *built to be* transport-swappable, but only Tier 1 ships.
- No blessed comparison `examples/` — the reproducible all-local vs all-Claude
  examples land at the end of Session 2, once the all-local path is contained.

---

## Decisions & constraints

Each is settled. Author-locked items are marked `[locked]`; the rest were
resolved from the v3 refinement pass and the tool-strategy research brief
([../local-builder-tool-strategy.md](../local-builder-tool-strategy.md)) and are
not open for relitigation during planning.

1. **The inner builder loop is one `engine.generate` call.** `[locked]` When
   `builder_provider` is local, `run_builder` makes a single
   `engine.generate({ tools: builder_tools(ctx), max_steps, … })` call whose
   fascicle tool loop *is* the builder's agentic loop — because fascicle's
   `generate` already drives a multi-step native tool loop (the local critic
   rides the same path with a smaller, read-only set). This keeps the inner loop
   fully inside one `generate`, so it cannot perturb the outer `loop`'s
   round accounting or carry-state, and the step history is discarded between
   iterations — preserving v2's fresh-context-per-iteration hygiene.

2. **The tool set is a small structured set *plus* bash — not pure-bash.**
   The research brief's central finding: "just bash" is a frontier-model luxury;
   a deliberately-weak local model benefits *most* from ACI guardrails (bounded
   reads, exact-match edits) and is punished worst by `cat`-everything bash and
   small context windows. The set is: `read_file`, `search_files`, `list_files`
   (reused verbatim from the critic), `write_file`, `edit_file`, `bash`,
   `fetch`, `finish`. This is the sensible ceiling — do not add more (tool-space
   interference degrades selection accuracy on weak models).

3. **`bash` is the general actuator; it is stateless per command.** `[locked]`
   Each `bash` call runs one command and captures stdout/stderr/exit — no
   persistent shell, no cwd/env carried between calls (mini-swe-agent's
   `subprocess.run` model). This is required for the local-builder + checkride
   combination (§9 of v2: the builder self-verifies by running `pnpm check`),
   and — decisively — the stateless design is the seam Session 2 swaps
   (`subprocess.run` → `docker exec`) without touching any tool contract.

4. **A non-zero `bash` exit is a *result*, not a harness error.** The builder
   loop sets `tool_error_policy: 'feed_back'`: a failing test or a non-zero exit
   is captured output the model should read and act on, fed back as a normal
   tool result. The same `feed_back` stance applies to `fetch` HTTP errors. A
   tool only *throws* on a genuine harness fault (containment violation,
   unreadable input).

5. **Transport is Tier 1 = native + salvage; Tier 2 (text-protocol) is
   deferred.** fascicle 0.8.13 shipped exactly the knobs the research brief
   asked for. The builder's local `generate` call sets:
   `tool_call_repair_attempts > 0` (salvages a tool call the model emitted as
   assistant *text* — Hermes `<tool_call>{…}</tool_call>`, bare/`json`-fenced, or
   Qwen3-Coder XML — accepted only when the name resolves *and* args validate
   against the tool's `input_schema`), `max_tool_calls_per_step: 1` (neutralizes
   the parallel-call failure mode), and `tool_error_policy: 'feed_back'`
   (Decision 4). This alone should carry a well-pinned runtime. The
   text-protocol transport (volley parses a fenced action from plain
   completion) is a *deferred* deeper fallback (Open Question 4), not part of
   this session — but the loop is structured so its encoding is swappable.

6. **Termination = both `max_steps` and an explicit `finish`.** `[locked]`
   The model calls `finish` when done (fast path); `max_steps` is the hard
   backstop. Neither alone (`max_steps` alone burns the whole budget every
   iteration; `finish` alone runs unbounded). `finish` takes a short `summary`
   string that volley logs to the trajectory and otherwise **ignores** — the
   workspace, not the builder's self-report, is the source of truth (mirrors the
   critic contract). `finish` is realized as a *tool* in native mode; it becomes
   a sentinel line if/when Tier 2 lands, but the LOCKED "explicit finish" holds
   either way.

7. **A `max_steps` cutoff is not an error.** When the loop hits the cap without
   `finish`, the (partial) worktree is handed to the check + critic exactly as a
   `finish`-terminated iteration would be: the critic sees incomplete work and
   requests changes; the loop continues. `finish_reason: 'max_steps'` (a real
   value in fascicle's `FinishReason` union) is surfaced as a warning line and
   recorded in the iteration summary, so a run that keeps hitting the cap is
   visible. This preserves v2's "non-convergence is data, not an exception."

8. **`web_search` is deferred out of v3; `fetch` ships.** `fetch` is
   `[locked]`. `web_search` was left to this pass to ship-or-defer: it is
   off-by-default, needs a search backend (SearXNG self-hosting fights the
   "fully offline" all-local goal, or a keyed hosted backend adds a network
   dependency), and is not needed to make the comparison informative. Defer it
   as a documented future increment. The all-local config relies on `fetch`
   only.

9. **`fetch` is a native pipeline, no MCP, no hosted reader.** GET → extract →
   markdown → truncate/paginate, built from `@mozilla/readability` +
   `linkedom` + `turndown` (three deps, no headless browser, keeps the run
   offline-capable). Contract mirrors the reference MCP fetch server and
   `read_file`'s byte-cap ergonomics: `fetch(url, max_chars?, start_index?)`
   returning a truncated slice with a "call again with start_index=N" marker.
   Never returns raw HTML; hard cap at `FETCH_MAX_BYTES`. SSRF deny-list
   (reject `localhost`/private IP ranges) lives *in the tool* (Session 2 adds
   the container network policy as an outer layer). Firecrawl (an ambient skill
   in this environment) is out of scope — volley's `fetch` is self-contained,
   matching how `src/critic/tools.ts` is already built.

10. **`edit_file` carries the highest-leverage ACI guardrail: exact-match-or-
    fail.** `old_str` must appear **exactly once** in the file → replaced with
    `new_str`; zero or multiple matches is a returned error the model reads and
    retries (the Anthropic `str_replace` contract Claude Code uses). This is the
    single change most likely to keep a weak model out of an edit-thrash spiral.
    An optional lint-on-edit (feed a syntax check back, reject edits that break
    the parse) is a follow-on enhancement, not a blocker (Open Question 2).

11. **A local builder without a sandbox is refused by default.** Giving a local
    model a real host `bash` is the exact write+exec surface the v2 critic was
    praised for *not* having, and this session ships that surface before the
    container does. So when `builder_provider` is local and no sandbox is
    configured, volley refuses to run unless the operator passes an explicit
    opt-out (`--allow-unsandboxed-builder` / `VOLLEY_ALLOW_UNSANDBOXED_BUILDER=1`),
    which prints a prominent one-time warning. Session 2 makes the sandbox the
    default path; this same opt-out then becomes the "I already run inside a
    devcontainer" escape hatch (shape C).

12. **Do not reuse the `claude_cli` builder system prompt for the local path.**
    That prompt assumes CLI semantics ("the current working directory", implicit
    `Bash`/`WebFetch`). The local builder needs a `harness_append_local`-style
    prompt (compare `src/critic/presets/harness_append_local.md`) that enumerates
    the volley-supplied tools, states the workspace is the working directory, and
    states the `finish` convention.

13. **A local builder's cost is `engine_derived` or `null`.** It never reports
    `provider_reported`. The cost accumulator (v2 §6) already folds
    `result.usage`/`result.cost` per phase regardless of provider; confirm the
    summary schema and the `max_cost_usd` cap logic behave sanely when a phase
    costs `$0`/`null` (a `null`-priced local phase must not silently trip or
    disable the cap). This is a verification, not new machinery.

---

## Builder tool surface (`src/builder/tools.ts`)

A sibling to `src/critic/tools.ts`, built with the same conventions: each tool
is typed as fascicle's `Tool` (input `unknown`), declares a zod `input_schema`
that drives the JSON schema the model sees, and re-parses the model's raw
arguments inside `execute`. Reuse `contain()` and the three read tools from
`src/critic/tools.ts` directly.

| Tool | Signature | Boundary / caps | Error semantics |
|---|---|---|---|
| `read_file` | `(path)` | Reused verbatim. `contain()`; `READ_FILE_MAX_BYTES` (200_000) with truncation marker. | Throws on containment violation. |
| `search_files` | `(pattern, path?, ignore_case?)` | Reused verbatim. `contain()`; `SEARCH_MAX_MATCHES` (200). | Throws on invalid regex / containment. |
| `list_files` | `(path?, contains?)` | Reused verbatim. `contain()`; `LIST_MAX_ENTRIES` (2000); skips `IGNORED_DIRS`. | Throws on containment. |
| `write_file` | `(path, content)` | `contain()`; `WRITE_FILE_MAX_BYTES` (1_000_000). Creates parent dirs. Overwrites. | Throws on containment / over-cap. |
| `edit_file` | `(path, old_str, new_str)` | `contain()`. Exact-match-or-fail: `old_str` must occur exactly once (Decision 10). | **Returns** an error result ("0 matches" / "N matches — make old_str unique") the model retries; throws only on containment. |
| `bash` | `(command)` | Stateless per command, runs in the workspace (Decision 3). `BASH_TIMEOUT_MS` (default 300_000, tunable — must accommodate a `pnpm check` run); `BASH_MAX_OUTPUT_BYTES` (100_000) with truncation marker. | **Returns** `{ exit_code, stdout, stderr }` for any exit incl. non-zero and timeout (Decision 4). Never throws on the command's own failure. |
| `fetch` | `(url, max_chars?, start_index?)` | Native readability+linkedom+turndown → markdown. `FETCH_MAX_BYTES` (200_000) hard cap; `max_chars` slice (default ~5000) + `start_index` pagination marker. SSRF deny-list. | **Returns** the HTTP/extraction error as a tool result (Decision 4/9). |
| `finish` | `(summary)` | — | Signals completion; `summary` logged to trajectory, otherwise ignored (Decision 6). |

Caps are named as module constants mirroring the critic's (`READ_FILE_MAX_BYTES`
etc.); the concrete default values above are reasonable starting points and are
tunable (Open Question 1).

**`fetch` failure modes to handle explicitly** (from the §6 prior art): (1)
JS-rendered SPAs yield empty extraction — detect short output, fall back to
raw-ish text; (2) token blowup — the hard cap; (3) SSRF — deny private ranges;
(4) non-HTML content (PDF/JSON), redirects, encodings; (5) paywall/bot-wall
boilerplate. `fetch` is disabled cleanly when the run is offline.

---

## Transport, termination, and the builder `generate` call

The local branch of `run_builder` calls `engine.generate` with (in addition to
`provider`, `model`, `system`, `prompt`, `abort`, `trajectory`, `on_chunk`):

```
tools: builder_tools(ctx),
max_steps: config.builder_max_steps,
tool_error_policy: 'feed_back',
tool_call_repair_attempts: <n > 0>,
max_tool_calls_per_step: 1,
```

All five are per-call `GenerateOptions` fields in fascicle 0.8.13 (verified in
`src/engine/types.ts`; per-call values win over engine defaults). No `schema`
is set — the builder produces a workspace, not a structured verdict; termination
is by `finish` tool / `max_steps`, and the result's `finish_reason` distinguishes
`'stop'` (a `finish` call or natural stop) from `'max_steps'` (the backstop,
surfaced per Decision 7).

**Salvage is observable and is a run-health metric.** A salvaged call sets
`salvaged`/`salvaged_format` on the `ToolCallRecord` and emits a
`tool_call_salvaged` trajectory event; a clamped parallel call emits
`tool_calls_dropped`. The builder is far more exposed than the read-only critic
(dozens of bash/edit turns), so the per-run salvage rate is worth recording in
the iteration summary as a health signal (and, later, a Session-2 comparison
datum).

**Pin model + runtime + parser as one unit.** Qwen speaks two incompatible tool
dialects (Qwen3 = Hermes JSON; Qwen3-Coder = XML `<function=…>`), requiring
different runtime parsers — crossing them silently drops calls. Prefer a
tool-capable build ≥ 8B whose dialect matches the runtime's parser. This is a
config/example concern for the pinned all-local model; state it in the
`harness_append_local` prompt's assumptions, don't hardcode it.

---

## Config and CLI surface

Reuse v2's rule: local defaults come from env with localhost fallbacks; the
ai-sdk peer is loaded lazily by fascicle only when the provider runs (already
true — see `create_volley_engine`).

| Flag / env | Governs | Notes |
|---|---|---|
| `--builder-max-steps` / `VOLLEY_BUILDER_MAX_STEPS` | The local builder loop bound (Decision 6). Per iteration. Default 50 (tunable). | Ignored for `claude_cli`. |
| `--allow-unsandboxed-builder` / `VOLLEY_ALLOW_UNSANDBOXED_BUILDER` | Opt-out that permits a local builder to run without a sandbox (Decision 11). | Prints a loud warning. Becomes shape-C support in Session 2. |
| `VOLLEY_OLLAMA_URL` / `VOLLEY_LMSTUDIO_URL` | Local provider endpoints. | **Already exist** (`src/engine.ts`), reused for the builder. |

Add `builder_max_steps` to `VolleyConfig`/`ResolvedConfig`, resolve it in
`src/config.ts` (default 50), thread it through `src/cli.ts` (`merge_flags` +
dry-run display), persist it (`src/workspace.ts`), and restore it on resume
(`src/iteration.ts`) defaulting like `builder_provider` does. A `ResolvedConfig`
`version` bump (2 → 3) is optional given default-on-restore (Open Question 5).

---

## Seams

The work attaches at exactly two seams, plus supporting plumbing:

- **`run_builder` in `src/builder.ts`** — branch on `config.builder_provider`
  the way `critic_tool_options` branches on `config.critic_provider` in
  `src/critic/run.ts`. The `claude_cli` arm is unchanged (its current body). The
  local arm builds the `generate` call above.
- **`src/builder/tools.ts` (new)** — sibling to `src/critic/tools.ts`; exports
  `builder_tools(ctx)` returning `Tool[]`. Imports `contain` and the three read
  tools from the critic module (or a shared module if a small refactor is
  cleaner).
- **`src/builder/presets/harness_append_local.md` (new)** — the local builder
  system prompt (Decision 12); composed by a `compose_builder_system_local()` (or
  branch inside `compose_builder_system`).
- **Config plumbing** — `builder_max_steps` and the unsandboxed opt-out through
  `types.ts` / `config.ts` / `cli.ts` / `workspace.ts` / `iteration.ts`.
- **No engine change** — `create_volley_engine` already wires a local provider
  selected by *either* role; the builder reuses that path.

### Already landed (mechanical plumbing — do not redo)

`builder_provider: 'claude_cli' | 'ollama' | 'lmstudio'` exists end-to-end:
`VolleyConfig`/`ResolvedConfig` (`src/types.ts`), resolution + validation
(`src/config.ts`, default `claude_cli`), `--builder-provider` flag (`src/cli.ts`),
engine wiring for either role's local provider (`src/engine.ts`), persistence
(`src/workspace.ts`) and resume-restore (`src/iteration.ts`). Setting it today
is inert for execution — this session is what makes it live.

---

## Prerequisites — Step 0 (DONE 2026-07-07)

**Sync fascicle to 0.8.13 — already done.** `package.json` declares
`fascicle: "^0.8.13"`; the lockfile and `node_modules` now resolve **0.8.13**
(the salvage/clamp options this session sets are present in the installed dist),
and `pnpm run typecheck` is clean. Fascicle 0.8.13 is published on npm as the
`latest` dist-tag (this corrects an earlier assumption that it was GitHub-only —
it is not).

One wrinkle had to be cleared: this environment enforces pnpm's supply-chain
quarantine (`minimumReleaseAge: 2880` ≈ 48h, `minimumReleaseAgeStrict: true`),
which refuses to install a version published in the last two days — and 0.8.13
was fresh. The fix (committed to `pnpm-workspace.yaml`) whitelists the in-house
package by name so every future fascicle release installs immediately:

```yaml
minimumReleaseAgeExclude:
  - fascicle
```

`minimumReleaseAgeStrict` only governs fallback when no version qualifies; it does
**not** disable the exclude list, so the whitelist is honored under strict mode.
`pnpm install` then upgraded 0.8.12 → 0.8.13 cleanly.

---

## Failure modes (extends v2 §9)

| Scenario | Expected behavior |
|---|---|
| `builder_provider: ollama` but the endpoint is unreachable | Provider error → exit 3, phase+iteration named (same as a `claude_cli` startup failure). `--dry-run` should catch it. |
| Local builder hits `max_steps` without calling `finish` | Not an error (Decision 7): partial workspace → check + critic → loop continues; warning + `finish_reason: 'max_steps'` recorded. |
| Local model emits a tool call as assistant text (mis-serialized def) | With `tool_call_repair_attempts > 0` the call is salvaged from Hermes/`json`/Qwen3-Coder-XML text, validated against the tool schema, executed normally, marked `salvaged` (`tool_call_salvaged` fires). Only a format salvage can't parse falls through. Only a *persistent* failure — not a one-off — is a builder error (exit 3). |
| Local model emits multiple/parallel tool calls a runtime mishandles | `max_tool_calls_per_step: 1` executes the first, drops the rest (each drop surfaces `dropped_max_tool_calls_per_step` + `tool_calls_dropped`); the model re-issues next turn. Not an error. |
| `bash` command times out / floods output | Truncated at `BASH_MAX_OUTPUT_BYTES`; timeout returned as a normal tool result the model can read; the *run* does not fail. |
| `fetch` fails (SSRF-denied, non-HTML, empty extraction, HTTP error) | Surfaced to the model as a tool result, not swallowed; run continues. Disabled cleanly when offline. |
| `edit_file` `old_str` matches 0 or >1 times | Returned error the model reads and retries with a more specific `old_str`; not a harness error. |
| Local builder selected with no sandbox and no opt-out | Config/preflight refusal (Decision 11) before any model spend. |

---

## Open questions (park — none blocks planning)

1. **Exact cap defaults.** `builder_max_steps` (50), `BASH_TIMEOUT_MS`
   (300_000), `BASH_MAX_OUTPUT_BYTES` (100_000), `WRITE_FILE_MAX_BYTES`
   (1_000_000), `FETCH_MAX_BYTES`/`max_chars` — sensible starting values; tune
   from live runs.
2. **`edit_file` lint-on-edit.** Whether to add the SWE-agent syntax-check
   guardrail (and with which checker — `tsc`/`oxlint`/language-aware) on top of
   exact-match-or-fail. Ship exact-match first.
3. **Line-windowed `read_file`.** The research favors a bounded, line-numbered
   window over the current whole-file byte cap for weak models. Reuse the byte
   cap for v3; revisit as an ACI enhancement.
4. **Tier 2 text-protocol transport.** Deferred. When native + salvage proves
   insufficient on a pinned runtime, add a mini-swe-agent-shaped fenced-action
   loop parsed by volley inside the one `generate` call, with `finish` as a
   sentinel line. Design the preflight canary (define one trivial tool, ask the
   pinned model to call it, assert a call is produced *or salvaged*) then.
5. **Config `version` bump.** Whether adding persisted fields warrants bumping
   `ResolvedConfig.version` 2 → 3, or default-on-restore suffices (it does for
   `builder_provider`).
