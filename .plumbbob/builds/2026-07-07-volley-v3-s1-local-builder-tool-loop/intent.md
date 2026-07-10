# volley v3 s1: local builder tool loop

*Source: `research/specs/volley-spec-v3-s1-local-builder.md` (plan-ready spec, author-converged 2026-07-07). Sibling: `volley-spec-v3-s2-sandbox-worktree.md` (containment — Session 2). Rationale: `volley-spec-v3.md`, `research/local-builder-tool-strategy.md`. Carries forward v2 (`volley-spec-v2.md`) unchanged unless a Decision says otherwise. Full source contracts preserved in `## Source` below.*

**Phase:** plan (steps authored; not yet built)
**Size:** medium

## Frame

- **Problem:** `builder_provider: ollama | lmstudio` is inert. The mechanical plumbing already landed (types/config/cli/engine/workspace/iteration), but `run_builder` in `src/builder.ts` still hardwires `provider: 'claude_cli'`, so selecting a local builder does nothing. A local model brings **no built-in tools**, so volley must supply the entire agentic surface (read/write/exec/fetch) and its own termination story.
- **Smallest thing that solves it:** a `src/builder/tools.ts` tool set plus a local branch in `run_builder` that runs **one bounded fascicle tool loop per iteration** against the local model, terminated by an explicit `finish` tool or a `max_steps` backstop. Tools run **on the host, in the workspace directory** — exactly where the `claude_cli` builder runs today. No Docker, no worktree yet.
- **Done looks like:** with a real local endpoint serving a pinned tool-capable model, `volley` completes a phase-sized task end-to-end through the volley tool loop — reads files, writes/edits files, runs `pnpm check` via `bash`, calls `finish` — and the outer loop treats the resulting workspace identically to a `claude_cli`-built one (check runs, critic critiques, loop continues or converges). A `max_steps` cutoff is handled as partial work, not an error. Unit tests cover every new tool; a `VOLLEY_LIVE=1` live test exercises the real local-provider path.
- **Explicitly NOT doing:** no Docker sandbox and no git worktree (Session 2 — until then the local `bash` runs unsandboxed on the host and is **refused by default**, D11); no `web_search` (deferred out of v3, D8); no text-protocol / Tier-2 transport (native + salvage only, D5 — the loop is *built* transport-swappable but only Tier 1 ships); no blessed comparison `examples/` (they land at the end of Session 2, once the all-local path is contained).

## Architecture sketch

```
outer loop  (fascicle `loop`, unchanged from v2)
  build → check (pnpm check / checkride) → critique → record → gate
   │
   └─ run_builder(config.builder_provider)                    ← the seam
        ├─ 'claude_cli'          → engine.generate (CLI session)      [UNCHANGED arm]
        └─ 'ollama' | 'lmstudio' → engine.generate({ … })   ONE call whose fascicle
                                                             native tool loop IS the
             system : builder harness_append_local          builder's agentic loop
             tools  : read_file search_files list_files      (reused verbatim)
                      write_file edit_file bash fetch finish  (new)
             max_steps, tool_error_policy:'feed_back',
             tool_call_repair_attempts:>0, max_tool_calls_per_step:1   (no schema)
             term   : finish (ends_turn:true, deterministic → 'stop') | max_steps (hard → 'max_steps')
                        ↓
        resulting workspace handed to check + critic identically to a CLI build
```

`bash` is **stateless per command** — that is the exact seam Session 2 swaps (`subprocess.run` → `docker exec`) with no tool-contract change (D3).

## Decisions

- D1 `[locked]`: Inner builder loop = one `engine.generate` call — *because* fascicle's `generate` already drives the multi-step native tool loop; keeping the inner loop inside one call means it cannot perturb the outer loop's round accounting, and step history is discarded between iterations, preserving v2's fresh-context-per-iteration.
- D2: Tool set = a small structured set **plus** `bash`, not pure-bash — *because* a deliberately-weak local model benefits *most* from ACI guardrails (bounded reads, exact-match edits) and is punished worst by `cat`-everything bash + small context. Set = `read_file`, `search_files`, `list_files` (reused), `write_file`, `edit_file`, `bash`, `fetch`, `finish`. This is the ceiling — adding more degrades selection accuracy (tool-space interference).
- D3 `[locked]`: `bash` is the general actuator, **stateless per command** — *because* it is required for builder self-verify (`pnpm check`) and, decisively, the stateless `subprocess.run` shape is the exact seam Session 2 swaps to `docker exec` without touching any tool contract.
- D4: A non-zero `bash` exit (and a `fetch` HTTP error) is a **result, not a harness error** — *because* a failing test / non-zero exit is output the model should read and act on; set `tool_error_policy: 'feed_back'`. Tools throw only on a genuine harness fault (containment violation, unreadable input).
- D5: Transport = Tier 1 native + salvage; Tier 2 text-protocol deferred — *because* fascicle 0.8.16 ships the exact knobs: set `tool_call_repair_attempts > 0` (salvages a call emitted as assistant text — Hermes / bare-or-`json`-fenced / Qwen3-Coder XML — accepted only when the name resolves *and* args validate), `max_tool_calls_per_step: 1`, `tool_error_policy: 'feed_back'`. The loop is structured so its encoding is swappable, but only Tier 1 ships (Q4).
- D6 `[locked]`: Termination = **both** `max_steps` **and** an explicit `finish` — *because* `max_steps` alone burns the whole budget every iteration and `finish` alone runs unbounded. `finish(summary)` is logged to the trajectory and otherwise ignored (the workspace, not the self-report, is truth). Mechanism (verified against installed 0.8.16): fascicle's `Tool` now carries a terminal-tool affordance (`ends_turn?: boolean`), so `finish` is declared `ends_turn: true` — a *successful* `finish` call ends the loop **deterministically** (the loop records the call + its trajectory events, then stops without another model turn) → `finish_reason: 'stop'`; a denied/invalid/dropped/throwing `finish` does **not** terminate (the loop continues), and a full `GenerateResult` (usage/cost/steps) is preserved either way. This upgrades the prior 0.8.13 *soft* signal (model had to choose to stop emitting calls) to a hard, weak-model-proof stop. `max_steps` is the hard backstop → `finish_reason: 'max_steps'`.
- D7: A `max_steps` cutoff is **not an error** — *because* the partial workspace goes to check + critic exactly as a `finish`-terminated iteration would (the critic sees incomplete work, requests changes, the loop continues); `finish_reason: 'max_steps'` is surfaced as a warning + recorded in the iteration summary. Preserves v2's "non-convergence is data, not an exception."
- D8: `web_search` deferred out of v3; `fetch` ships `[locked]` — *because* `web_search` needs a search backend that either fights the offline all-local goal (self-hosted SearXNG) or adds a network dependency (hosted+keyed), and is not needed for an informative comparison. The all-local config relies on `fetch` only.
- D9: `fetch` is a native pipeline (`@mozilla/readability` + `linkedom` + `turndown`), no MCP / hosted reader — *because* three deps and no headless browser keep the run offline-capable (trio validated 2026-07-09: the Node ecosystem converges on exactly it — `@extractus/article-extractor` and `defuddle` both sit on linkedom/turndown underneath). SSRF protection lives **in the tool at the connector, not as a pre-flight URL check**: a validating `lookup` on an undici `Agent` (via `@atproto-labs/fetch-node` or a vendored ~60-line pattern + `ipaddr.js` non-unicast rejection) — *because* a pre-flight deny-list misses DNS rebinding (TOCTOU), redirects into private ranges, and IP-representation tricks (`::ffff:127.0.0.1`, decimal IPs, `0.0.0.0`); with the connector approach every redirect hop re-resolves through the validated lookup. Session 2 adds the container network policy as the outer layer. Contract mirrors the reference MCP fetch server (`max_chars` slice over converted markdown + the self-describing "call again with start_index=N" truncation trailer) + `read_file`'s byte-cap ergonomics.
- D10: `edit_file` = **exact-match-or-fail** — *because* `old_str` must occur exactly once → replaced; 0 or N matches is a *returned* error the model reads and retries (the Anthropic `str_replace` contract); this is the single change most likely to keep a weak model out of an edit-thrash spiral.
- D11: A local builder without a sandbox is **refused by default** — *because* handing a local model a real host `bash` is the write+exec surface the v2 critic was praised for *not* having, and it ships before the container does. Refuse unless `--allow-unsandboxed-builder` / `VOLLEY_ALLOW_UNSANDBOXED_BUILDER=1` is passed (loud one-time warning). In Session 1 there is no sandbox concept, so the refusal condition is simply *local builder && no opt-out*; Session 2 makes the sandbox the default and this opt-out becomes the "I already run in a devcontainer" escape hatch (shape C).
- D12: Do **not** reuse the `claude_cli` builder system prompt for the local path — *because* it assumes CLI semantics (implicit `Bash`/`WebFetch`, "the current working directory"). The local builder needs a `harness_append_local`-style prompt enumerating the volley-supplied tools, stating the workspace is the working directory, and stating that calling `finish` ends the turn (harness-enforced via `ends_turn`, not a request to keep working).
- D13: A local builder's cost is `engine_derived` or `null`, never `provider_reported` — *because* the accumulator already folds `result.usage`/`result.cost` per phase; this session must **verify** the `max_cost_usd` cap logic and summary schema behave when a phase costs `$0`/`null` (a null-priced phase must not silently trip or disable the cap). Verification, not new machinery.

## Constraints

- C1: House style — snake_case values/functions/filenames, PascalCase types, **no classes in `src/`**, ESM-only, Node ≥ 24, functional/procedural (grep-enforced by v2 §10). New tests are vitest.
- C2: **No engine change** — `create_volley_engine` already wires a local provider for either role; the builder reuses that path. `create_engine` may appear **only** in `src/engine.ts`.
- C3: The `claude_cli` builder arm is **unchanged** and additive-only — the all-Claude path must behave identically (v2 §8 fairness); assert it in tests.
- C4: `builder_tools` **reuses** `contain()` and the three read tools via a small shared module (e.g. `src/workspace_tools.ts`, with `src/critic/tools.ts` importing from it) — do not fork them. A direct `'../critic/tools.js'` import from `src/builder/` is **rule-blocked** (`no-deep-sibling-import`; verified against the rule 2026-07-09), so the shared module is the design, not a fallback.
- C5: On the local branch set exactly five per-call `GenerateOptions`: `tools`, `max_steps`, `tool_error_policy: 'feed_back'`, `tool_call_repair_attempts: >0`, `max_tool_calls_per_step: 1`; **no `schema`** (the builder produces a workspace, not a verdict). Per-call values win over engine defaults.
- C6: `bash` stays **stateless per command** (D3, the Session-2 swap seam) — no persistent shell/cwd/env across calls.
- C7: `fetch` never returns raw HTML; hard cap at `FETCH_MAX_BYTES` enforced at the HTTP stream (before conversion, so a huge page cannot OOM the tool); SSRF validation happens at connection time on resolved addresses (non-unicast → reject), never as a pre-flight URL check (D9); disabled cleanly when offline.

## Steps

1. [x] Config: thread `builder_max_steps` (default 50) — **done when:** `test/unit/config.test.ts` covers the default (50), positive-integer validation, `--builder-max-steps` / `VOLLEY_BUILDER_MAX_STEPS` override (flag > env > default), and a persist→restore round-trip preserves the value; `pnpm check` clean.
   - seam: `src/types.ts`, `src/config.ts`, `src/cli.ts`, `src/workspace.ts`, `src/iteration.ts`, `test/unit/config.test.ts`
   - model: sonnet — mechanical threading that mirrors the already-landed `builder_provider` pattern file-for-file
2. [x] Safety gate: unsandboxed-builder refusal + opt-out (D11) — **done when:** a test shows a local `builder_provider` with no opt-out throws a `config_error` before any model spend (and `--dry-run` refuses it too), while `--allow-unsandboxed-builder` / `VOLLEY_ALLOW_UNSANDBOXED_BUILDER=1` proceeds and emits one loud warning.
   - seam: `src/config.ts` (refusal, no renderer), `src/types.ts` (`allow_unsandboxed_builder` field), `src/cli.ts` (flag + `dry_run` display + warn), `test/unit/config.test.ts`
   - model: sonnet — small config gate with fully specified refusal/opt-out semantics and an existing validation pattern to copy
3. [x] `builder_tools` core: read reuse + `write_file` + `edit_file` + `finish` — **done when:** `test/unit/builder_tools.test.ts` covers `write_file` (happy / over-cap / containment-throw), `edit_file` (happy / 0-match returned-error / N-match returned-error / containment-throw), and `finish` (returns cleanly, declared `ends_turn: true`); the exported tool-name list is asserted; the shared-module hoist keeps `test/unit/critic_tools.test.ts` green untouched.
   - seam: `src/workspace_tools.ts` (new shared module — `contain` + the three read tools move here; `src/critic/tools.ts` imports from it), `src/builder/tools.ts` (new — imports the shared module, NOT `'../critic/tools.js'`, which trips `no-deep-sibling-import` per C4), `test/unit/builder_tools.test.ts` (new)
   - model: opus — cross-module hoist under rule constraints (C4, critic tests must stay green untouched) plus the edit-contract subtleties (D10)
4. [x] `bash` tool — stateless actuator (D3/D4, the Session-2 swap seam) — **done when:** unit tests show a zero-exit command returns stdout, a non-zero exit is **returned** (`{exit_code,stdout,stderr}`) not thrown, oversized output is truncated at `BASH_MAX_OUTPUT_BYTES`, and a timeout is returned as a normal result (`BASH_TIMEOUT_MS`, sized to fit a `pnpm check`).
   - seam: `src/builder/tools.ts`, `test/unit/builder_tools.test.ts`
   - model: sonnet — one well-specified tool with a tight never-throw contract; subtle edges (timeout, truncation) are all named in the done-when
5. [x] `fetch` tool — native readability pipeline + connector-level SSRF (D9) — **done when:** deps `@mozilla/readability` + `linkedom` + `turndown` are added, plus the SSRF connector (`@atproto-labs/fetch-node`, or `ipaddr.js` + a vendored undici-`Agent` validating `lookup`); unit tests show a private-range / localhost URL is rejected at connection time as an error result (not thrown) **including a redirect-to-private-range case**; an HTML fixture extracts to markdown with the MCP-style truncation trailer ("call again with start_index=N") past the `max_chars` slice; empty/non-HTML input is handled; `FETCH_MAX_BYTES` is enforced at the HTTP stream, never raw HTML returned.
   - seam: `package.json` (+3–4 deps; whitelist via `pnpm-workspace.yaml` `minimumReleaseAgeExclude` only if a version is <48h old), `src/builder/tools.ts`, `test/unit/builder_tools.test.ts`
   - model: opus — security-sensitive (connector-level SSRF, DNS-rebinding class) and the largest new surface: multi-dep pipeline + stream cap + pagination contract
6. [x] Local builder system prompt (D12) — **done when:** a unit test asserts the local prompt names the volley tool set (`read_file`/`search_files`/`list_files`/`write_file`/`edit_file`/`bash`/`fetch`/`finish`) + the workspace-is-cwd convention + states that calling `finish` ends the turn (the harness stops the loop on a successful call — `ends_turn`) + the whole-file fallback policy (after repeated `edit_file` failures on one file, rewrite it with `write_file` — Aider's escape hatch) + a brief plan-first instruction (state the plan before the first tool call), and that the `claude_cli` builder prompt is unchanged; `package.json` `files` gains `src/builder/presets` (publish surface — today it ships only `src/critic/presets`).
   - seam: `src/builder/presets/harness_append_local.md` (new, mirroring `src/critic/presets/harness_append_local.md`), `src/builder.ts` (`compose_builder_system_local()` or a branch, with a builder `presets_dir()` resolver), `package.json` (`files`), `test/unit/builder_prompt.test.ts`
   - model: opus — small diff but the prompt wording IS the artifact; weak-local-model reliability hinges on it (D12), so spend the stronger model here
7. [x] `run_builder` local branch — the wiring seam — **done when:** `test/integration/local_builder.test.ts` (mock engine, mirroring `local_critic.test.ts`) asserts the builder call routes to `ollama` with the five options + `builder_tools` + the local prompt and **no** `claude_cli` `provider_options`, the `claude_cli` arm is byte-for-byte unchanged, and the produced workspace runs check + critic to `success`.
   - seam: `src/builder.ts` (branch `run_builder` on `config.builder_provider`, mirroring `critic_tool_options` in `src/critic/run.ts`), `test/integration/local_builder.test.ts` (new)
   - model: opus — the load-bearing wiring seam: everything from steps 1–6 converges here, and C3's byte-for-byte-unchanged claude_cli arm (§8 fairness) must be proven, not assumed
8. [x] Termination surfacing + salvage-rate health metric (D7) — **done when:** an integration test with a mock `max_steps`-terminated result shows a renderer warning, `finish_reason` + salvage-rate recorded in `.volley/iterations/NNN/summary.json`, the `finish` `summary` logged to the trajectory, and the run continuing to check + critic (not an error).
   - seam: `src/cost.ts` (`phase_record` reads `result.finish_reason` + counts salvaged tool calls on `result.tool_calls`), `src/types.ts` (`PhaseRecord` fields), `src/iteration.ts` (`phase_summary`), `src/builder.ts` + `src/render/renderer.ts` (max_steps warning), `test/integration/local_builder.test.ts`
   - model: sonnet — field threading through existing record/summary/render paths; fascicle's `GenerateResult` fields are already verified in the D6/D5 verdicts
9. [ ] Cost sanity for a `$0`/`null` local phase (D13) — *verification* — **done when:** a test with a zero-cost builder phase under a `max_cost_usd` cap asserts the cap is **not** tripped by `$0`, `builder_cost_usd`/totals are accurate, and the summary is sane (extends the `local_critic` zero-cost pattern to the builder); add a guard only if a gap is found.
   - seam: `test/integration/local_builder.test.ts` or `test/unit/cost.test.ts` (+ `src/cost.ts` only if a fix is needed)
   - model: sonnet — verification tests extending the existing `local_critic` zero-cost pattern; the $0-must-not-trip-or-disable-the-cap edge is subtle but fully stated
10. [ ] Live path (`VOLLEY_LIVE=1`) + usage docs — **done when:** a gated live test drives a phase-sized task through a real local provider (reads, writes/edits, `bash` runs `pnpm check`, `finish`) and asserts the outer loop treats the workspace like a `claude_cli` build; `README` documents `--builder-provider`, `--builder-max-steps`, `--allow-unsandboxed-builder`, the pin-model/runtime/parser-as-one-unit caveat, the Ollama context-length requirement (`num_ctx` ≥ ~16k — the 4k default silently truncates tool schemas, the #1 reported local-tool-calling failure; warn at builder start where detectable), and the LM Studio fallback (0.4.1+ ships an Anthropic-compatible `/v1/messages` endpoint with field reports of fixing OpenAI-compat tool-call parsing for Qwen-class models).
    - seam: `test/integration/live_smoke.test.ts` (or new `live_local_builder.test.ts`), `README.md`
    - model: opus — live debugging against a real local runtime is the least predictable step (runtime/parser quirks, num_ctx, dialect pinning); diagnosis quality matters more than diff size

## Open questions

*(Parked from the spec — none blocks planning or building the early steps.)*

- Q1: Exact cap defaults — `builder_max_steps` (50), `BASH_TIMEOUT_MS` (300_000 — note: volley's own checkride timeout is 600s, so a workspace `pnpm check` can exceed a 300s bash budget; consider 600_000), `BASH_MAX_OUTPUT_BYTES` (100_000), `WRITE_FILE_MAX_BYTES` (1_000_000), `FETCH_MAX_BYTES` (200_000) / `max_chars` (~5000). *Resolve by:* ship these, tune from live runs (Step 10).
- Q2: `edit_file` lint-on-edit. Concrete design from research (2026-07-09): run a cheap syntax check after each edit and append diagnostics to the tool result, always prefixed with "edit applied" — bare diagnostics make weak models believe the edit failed and loop (opencode #9102); SWE-agent's ablations rank reject-on-broken-syntax the single highest-leverage ACI intervention. *Resolve by:* decide later — ship exact-match-or-fail first (Step 3).
- Q3: Line-windowed `read_file`. Concrete shape from research (2026-07-09): `offset`/`limit` params on `read_file` subsume dedicated scroll/viewer machinery (opencode / Claude Code shape). *Resolve by:* decide later — reuse the byte cap for v3.
- Q4: Tier 2 text-protocol transport (mini-swe-agent-shaped fenced-action loop parsed by volley, `finish` as a sentinel line; design the preflight canary then). *Resolve by:* spike if native + salvage proves insufficient on a pinned runtime.
- Q5: Config `version` bump (2 → 3) vs. default-on-restore for the new persisted fields. *Resolve by:* decide in Step 1 — default-on-restore suffices for `builder_provider`, so likely here too.

## Verdicts

- 2026-07-07 — finish-termination mechanism → confirmed fascicle 0.8.13 has no terminal-tool affordance, so `finish` is a **soft** signal (model stops after the call → `finish_reason: 'stop'`) with `max_steps` as the hard backstop; a full `GenerateResult` is preserved either way. Folded into D6; not an open question. **Superseded 2026-07-08 (see below).**
- 2026-07-08 — dependency upgrade → fascicle **0.8.16** / checkride **0.2.1** installed (`pnpm check` clean). fascicle 0.8.16 adds a terminal-tool affordance `ends_turn?: boolean` to `Tool`: a successful `ends_turn: true` call ends the loop deterministically (per-step `finish_reason: 'tool_calls'`, overall `finish_reason: 'stop'`; verified in `node_modules/fascicle/dist/index.js` ~L4315/L4354/L4371), and a terminal call is exempt from `max_tool_calls_per_step` clamping (~L4125). `finish` therefore becomes a **hard** deterministic stop (D6 updated) instead of the 0.8.13 soft signal — strictly better for a weak local model. The five per-call knobs (D5/C5) and `max_steps → 'max_steps'` (D7) are unchanged. checkride 0.2.1 is additive over 0.1.x (baseline, PM-agnostic runs, opt-in `format`/`publint`/`attw`/`extends`; 0.2.1 itself is a spell-scaffold fix); the existing `checkride.config.json` validates unchanged.
- 2026-07-09 — plan review vs code + ecosystem research + fascicle-upgrade evaluation (three research passes: local-agent harnesses, fetch/SSRF deps, AI SDK v7):
  - **Two plan defects found and folded in:** (1) step 3's planned `'../critic/tools.js'` import trips the `no-deep-sibling-import` ast-grep rule (probe-verified) → shared module is now the design (C4, step 3); (2) `package.json` `files` ships only `src/critic/presets` → step 6 adds `src/builder/presets` to the publish surface.
  - **Architecture validated by prior art:** stateless-per-command bash is mini-swe-agent's proven design (`subprocess.run`, >74% SWE-bench Verified); explicit `finish` matches OpenHands `FinishTool` / Cline `attempt_completion` (summary-only payload is the consensus — nobody puts patch/evidence in the finish call); the ≤8-tool ceiling is empirically right (goose #6883: Qwen3-Coder flips to raw-XML output as the tool count grows toward ~11); Tier-1 native+salvage is the pattern goose shipped as its fix, and recent Ollama normalizes Qwen-XML → `tool_calls` server-side, making fascicle's salvage the right *insurance* rather than the primary path. Tier-2 deferral (D5) validated: the ecosystem is moving toward native calling, and mini-swe-agent stands as the proof the text-protocol fallback can stay tiny if ever needed.
  - **D9 amended:** fetch trio confirmed (ecosystem converges on it), but pre-flight SSRF deny-lists are insufficient — protection moved to a validating `lookup` inside the undici connector (closes DNS rebinding, redirect hops, IP-representation tricks); byte cap enforced at the HTTP stream.
  - **fascicle v7 / provider-sovereignty → proceed on 0.8.16, do not wait.** The `ai-sdk-v7` branch is specs-only (`ai` still `^6.0.0`); both specs explicitly scope out "the tool loop's control semantics [and] the public flow surface" — i.e. everything S1 consumes (the five knobs + `ends_turn`), so the eventual upgrade is a pin bump with likely zero volley change. AI SDK 7 GA'd 2026-06-25 and shipped a tool-call-streaming regression fixed 13 days post-GA (an argument for letting it bake); the reliability ceiling for Qwen-class tool loops is the runtime's template/parser layer (Ollama #14493 still open), which no transport choice fixes. The dependency arrow points the other way: S1's live runs + step 8's salvage-rate metric are the production mileage fascicle's native-Ollama / transport-default questions (sovereignty Q2–Q4) need.

## Source

The distilled Decisions and Steps above stand on their own for building. The three detailed contract tables from the spec are preserved here (as amended by the 2026-07-09 verdict: shared-module reuse per C4, connector-level SSRF per D9) — they are the build spec for the tools and config surface. Full prose/rationale: `research/specs/volley-spec-v3-s1-local-builder.md`.

### Builder tool surface (`src/builder/tools.ts`)

A sibling to `src/critic/tools.ts`: each tool is typed as fascicle's `Tool` (input `unknown`), declares a zod `input_schema` that drives the JSON schema the model sees, and re-parses the raw arguments inside `execute`. Reuse `contain()` and the three read tools via the shared module (C4 — a direct sibling import is rule-blocked).

| Tool | Signature | Boundary / caps | Error semantics |
|---|---|---|---|
| `read_file` | `(path)` | Reused verbatim. `contain()`; `READ_FILE_MAX_BYTES` (200_000) with truncation marker. | Throws on containment violation. |
| `search_files` | `(pattern, path?, ignore_case?)` | Reused verbatim. `contain()`; `SEARCH_MAX_MATCHES` (200). | Throws on invalid regex / containment. |
| `list_files` | `(path?, contains?)` | Reused verbatim. `contain()`; `LIST_MAX_ENTRIES` (2000); skips `IGNORED_DIRS`. | Throws on containment. |
| `write_file` | `(path, content)` | `contain()`; `WRITE_FILE_MAX_BYTES` (1_000_000). Creates parent dirs. Overwrites. | Throws on containment / over-cap. |
| `edit_file` | `(path, old_str, new_str)` | `contain()`. Exact-match-or-fail: `old_str` must occur exactly once (D10). | **Returns** an error ("0 matches" / "N matches — make old_str unique") the model retries; throws only on containment. |
| `bash` | `(command)` | Stateless per command, runs in the workspace (D3). `BASH_TIMEOUT_MS` (300_000, tunable — must fit a `pnpm check`); `BASH_MAX_OUTPUT_BYTES` (100_000) with truncation marker. | **Returns** `{ exit_code, stdout, stderr }` for any exit incl. non-zero and timeout (D4). Never throws on the command's own failure. |
| `fetch` | `(url, max_chars?, start_index?)` | Native readability+linkedom+turndown → markdown. `FETCH_MAX_BYTES` (200_000) hard cap at the HTTP stream; `max_chars` slice (~5000) + `start_index` pagination with the MCP truncation trailer. SSRF: connection-time non-unicast rejection via undici-connector `lookup` (D9). | **Returns** the HTTP/extraction/SSRF error as a tool result (D4/D9). |
| `finish` | `(summary)` | Declared `ends_turn: true` (D6). | A successful call ends the loop deterministically → `finish_reason: 'stop'`; `summary` logged to trajectory, otherwise ignored. A denied/invalid/dropped/throwing call does **not** terminate. |

`fetch` failure modes to handle explicitly: (1) JS-rendered SPAs → empty extraction (detect short output, fall back to raw-ish text); (2) token blowup → the hard cap; (3) SSRF → deny private ranges; (4) non-HTML (PDF/JSON), redirects, encodings; (5) paywall/bot-wall boilerplate. Disabled cleanly when offline.

### The builder `generate` call (local branch of `run_builder`)

In addition to `provider`, `model`, `system`, `prompt`, `abort`, `trajectory`, `on_chunk`:

```
tools: builder_tools(ctx),
max_steps: config.builder_max_steps,
tool_error_policy: 'feed_back',
tool_call_repair_attempts: <n > 0>,
max_tool_calls_per_step: 1,
```

All five are per-call `GenerateOptions` fields in fascicle 0.8.16 (verified in the installed dist; per-call wins over engine defaults). No `schema`. The `finish` tool inside `builder_tools(ctx)` additionally carries `ends_turn: true` (0.8.16's terminal-tool affordance, D6) — a tool-level field, not one of the five options. Salvage is observable (`salvaged`/`salvaged_format` on `ToolCallRecord`, `tool_call_salvaged` event; clamped parallel calls emit `tool_calls_dropped`) and is worth recording as a per-run health metric. Pin model + runtime + parser as one unit (Qwen3 = Hermes JSON vs Qwen3-Coder = XML — crossing dialects silently drops calls); state it in the prompt's assumptions, do not hardcode.

### Config and CLI surface

| Flag / env | Governs | Notes |
|---|---|---|
| `--builder-max-steps` / `VOLLEY_BUILDER_MAX_STEPS` | The local builder loop bound (D6). Per iteration. Default 50 (tunable). | Ignored for `claude_cli`. |
| `--allow-unsandboxed-builder` / `VOLLEY_ALLOW_UNSANDBOXED_BUILDER` | Opt-out permitting a local builder to run without a sandbox (D11). | Prints a loud warning. Becomes shape-C support in Session 2. |
| `VOLLEY_OLLAMA_URL` / `VOLLEY_LMSTUDIO_URL` | Local provider endpoints. | **Already exist** (`src/engine.ts`), reused for the builder. |

Add `builder_max_steps` to `VolleyConfig`/`ResolvedConfig`, resolve in `src/config.ts` (default 50), thread through `src/cli.ts` (`merge_flags` + dry-run display), persist (`src/workspace.ts`), restore on resume (`src/iteration.ts`) defaulting like `builder_provider`. A `ResolvedConfig.version` bump (2 → 3) is optional given default-on-restore (Q5).

### Already landed — do NOT redo (mechanical plumbing)

`builder_provider: 'claude_cli' | 'ollama' | 'lmstudio'` exists end-to-end: `VolleyConfig`/`ResolvedConfig` (`src/types.ts`), resolution + validation (`src/config.ts`, default `claude_cli`), `--builder-provider` flag (`src/cli.ts`), engine wiring for either role's local provider (`src/engine.ts`), persistence (`src/workspace.ts`), resume-restore (`src/iteration.ts`). Setting it today is inert for execution — this session makes it live. Step 0 (fascicle → 0.8.16, checkride → 0.2.1) is DONE (installed; `pnpm check` clean).

### Failure modes (extends v2 §9)

| Scenario | Expected behavior |
|---|---|
| `builder_provider: ollama` but endpoint unreachable | Provider error → exit 3, phase+iteration named (same as a `claude_cli` startup failure). `--dry-run` should catch it. |
| Local builder hits `max_steps` without `finish` | Not an error (D7): partial workspace → check + critic → loop continues; warning + `finish_reason: 'max_steps'` recorded. |
| Local model emits a tool call as assistant text | `tool_call_repair_attempts > 0` salvages from Hermes/`json`/Qwen3-Coder-XML, validates against the tool schema, executes, marks `salvaged`. Only a *persistent* failure is a builder error (exit 3). |
| Local model emits multiple/parallel tool calls | `max_tool_calls_per_step: 1` executes the first, drops the rest (`tool_calls_dropped`); the model re-issues next turn. Not an error. |
| `bash` times out / floods output | Truncated at `BASH_MAX_OUTPUT_BYTES`; timeout returned as a normal tool result; the run does not fail. |
| `fetch` fails (SSRF-denied, non-HTML, empty, HTTP error) | Surfaced to the model as a tool result, not swallowed; run continues. Disabled cleanly when offline. |
| `edit_file` `old_str` matches 0 or >1 times | Returned error the model reads and retries with a more specific `old_str`; not a harness error. |
| Local builder selected with no sandbox and no opt-out | Config/preflight refusal (D11) before any model spend. |
