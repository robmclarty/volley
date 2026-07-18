# v0.4.1 — critic resilience, matrix runner, docs truth

**Phase:** frame
**Size:** medium

*Source: repo review conversation, 2026-07-17 (post-v0.4.0, grounded in
`research/v3-comparison-finding.md`).*

## Frame

- **Problem:** The v3 comparison proved the all-local path works end-to-end,
  but also that the critic seat is fragile: qwen3.6-as-critic reproducibly dies
  on Ollama's server-side tool-XML parser, killing a run *after* the builder
  did perfect work — and nothing in preflight catches the doomed combination
  before spend. Meanwhile, finding the optimal builder×critic matchup means
  hand-editing model flags on a long `docker run` line per combo, and the main
  README still describes the pre-sandbox world: anyone landing on v0.4.0 is
  told its headline feature ("volley has no container sandbox yet") doesn't
  exist.
- **Smallest thing that solves it:** Make the critic phase degrade instead of
  die (bounded retry → tool-less fallback, both recorded honestly); catch a
  doomed critic model at `--dry-run` time with a $0 canary; ship a matrix
  runner that sweeps builder×critic combos and aggregates the existing
  `comparison` blocks into one table; bring the README to v0.4.0 truth. Draft
  (not file) the upstream Ollama report. Optionally prove critic-swap
  generality with an essayist example.
- **Done looks like:** A run with qwen3.6 in the critic seat completes with a
  verdict (degraded, and marked so) instead of exit 6; `--dry-run` refuses that
  combo up front with a named model×seat; `volley matrix` over a 2×2 local
  combo set emits one aggregate table; the README flag table matches
  `src/cli.ts` exactly; `pnpm check` green throughout.
- **Explicitly NOT doing:**
  - *Running* the capability-ladder experiments — the build **authors** the
    ladder examples as runnable repo artifacts (step 8); actually sweeping them
    through the matrix runner is post-build usage.
  - The native Ollama transport flip (stays OQ-6; bridge trigger unchanged).
  - Any sandbox/worktree changes — B′/D5 shipped and is not reopened here.
  - Filing the Ollama issue — the build drafts the text; filing is the human's
    external action.
  - The plumbbob build-slot agent integration (separate future build).
  - Builder-phase retry on stream errors (Q5 verdict: critic-only this build;
    a builder stream death leaves a half-written workspace — parked).

## Architecture sketch

```
critic phase (local provider)
  generate(tools + schema) ──stream death?──> retry once (same call)     [OQ-11]
        │                                          │ still dies
        │ ok                                       v
        v                                  generate(NO tools + schema)   [OQ-12]
     verdict                                       │ ok → verdict + critic_degraded
                                                   │ dies → phase_error (as today)
--dry-run (local critic only)
  canary generate: real tool wiring + verdict_schema, ~1 token, $0
  fail → exit 5 naming model×seat (before any builder spend)

volley matrix --builders a,b --critics c,d
  serial cross product over an otherwise-normal config
  per-combo run state → one aggregate table from `comparison` blocks
```

## Decisions

- D1: **Degradation ladder order: retry-with-tools once → tool-less fallback →
  fail** — *because* the stream-death is stochastic (a same-call retry may
  pass) and the full-tools critique is strictly richer; give it one chance
  before trading read access for survival.
- D2: **The retry/fallback ladder applies to local providers only**
  (`ollama`/`lmstudio`) — *because* the `claude_cli` critic path is proven, has
  different failure modes, and its retries cost real money.
- D3: **A degraded verdict is always marked** — `critic_degraded: true` in the
  iteration summary and surfaced in the `comparison` block — *because* a
  verdict rendered without reading the workspace must never pass silently as a
  full one.
- D4: **The tool-less fallback keeps constrained decode** — *because* schema
  enforcement is the part that works; only the tool surface enters Ollama's
  broken parser path, and the critic prompt already carries criteria + raw
  check artifacts, so a tool-less verdict is grounded, just shallower.
- D5 *(amended per Q6/Q7)*: **The `--dry-run` canary runs only for a local
  critic, costs $0, and must elicit a real tool call** — a short `generate`
  through the *real* tool wiring + `verdict_schema` whose prompt instructs the
  model to invoke a read tool before answering (a 1-token call would never
  enter Ollama's tool parser and could not fail) — *because* the qwen3.6 death
  happens at tool-markup emission. **Canary failure warns and predicts
  degradation; it does not exit 5** — the fallback ladder means the combo
  survives a real run, so refusing it would contradict step 2. Exit 5 remains
  for failures that would fail even degraded (endpoint down, model missing). A
  stochastic canary pass is acceptable: the canary is early warning, the ladder
  is the guarantee.
- D8: **The ladder triggers on fascicle's typed `provider_error` only**
  (`err.kind === 'provider_error'`, guarded by `!abort.aborted`) — *because*
  fascicle exposes typed error classes (spiked 2026-07-17):
  `schema_validation_error` stays exit-6, aborts stay exit-130, and no string
  matching is needed. `cause_kind` (`provider_5xx`/`network`/`unknown`) is
  recorded with the retry count.
- D9: **The tool-less fallback prompt carries a workspace file inventory**
  (paths + sizes, no contents) — *because* under `check: 'none'` a tool-less
  critic would otherwise judge blind; a few lines of code keeps the degraded
  verdict minimally grounded.
- D10: **Example gates stay dependency-free**: the essayist check is a plain
  node script (word count / structure / citations-present), not vale; the
  dependency-wrangling ladder probe is disclosed **online-only** in the ladder
  README — *because* the sandbox's egress posture is deny-by-default (allowlist
  to host Ollama only, or `--network none`), so an in-sandbox `pnpm add` cannot
  reach the npm registry.
- D11: **`volley matrix` requires a git-repo workspace and forces `--worktree`
  per combo** — *because* the existing worktree teardown gives clean per-combo
  resets with zero new reset machinery. Per-combo `summary.json` is copied to
  `.volley-matrix/<builder>__<critic>/` before teardown; the sweep exits 0 when
  every combo produced a summary (a non-converging combo is a *result*, shown
  in the table), nonzero only when the sweep itself broke.
- D6: **Matrix runner is a `volley matrix` subcommand, serial execution** —
  *because* a subcommand reuses `resolve_config`/worktree reset instead of
  reimplementing them in bash, and local models share one GPU: parallel combos
  would thrash the Ollama loader.
- D7: **README truth is verified against `src/cli.ts`, not memory** — *because*
  the drift being fixed came from documenting intent instead of shipped flags.

## Constraints

- C1: No new runtime dependencies — the ladder, canary, and matrix build on
  fascicle + existing wiring only.
- C2: House style holds: snake_case functions, no deep sibling imports
  (`src/critic/` never imports `../builder/*` — ast-grep enforced).
- C3: stdout stays machine-pure; all new human-readable output (matrix
  progress, degradation warnings) goes to stderr. `--json` contracts unbroken.
- C4: Existing exit-code semantics preserved; exit 6 still means "critic failed
  after the full ladder," and the canary reuses exit 5.
- C5: Every summary-schema addition (`critic_degraded`, retry count) is
  additive — old consumers of `summary.json` keep parsing.

## Steps

1. [x] OQ-11: bounded critic retry on provider stream errors — **done when:** a unit test simulating a stream-death on the first critic call and success on the second sees the iteration complete, with the retry counted in the iteration summary
   - seam: `src/critic/run.ts`, `src/types.ts`, `test/critic_retry.test.ts`
   - model: opus — error-path semantics with an existing phase_error contract to preserve

2. [ ] OQ-12: tool-less critic fallback + `critic_degraded` marker — **done when:** a test simulating persistent tool-phase stream death still yields a schema-valid verdict, and `summary.json` (iteration + comparison block) carries `critic_degraded: true`
   - seam: `src/critic/run.ts`, `src/summary.ts`, `src/types.ts`, `test/critic_fallback.test.ts`
   - model: opus — the degradation ladder is the build's core judgment call

3. [ ] Critic-seat canary in `--dry-run` — **done when:** with a local critic configured, `--dry-run` issues one tiny generate through the real tool wiring + `verdict_schema` and exits 5 naming model×seat on failure; a faked-engine unit test covers both outcomes; the claude_cli critic path provably skips it
   - seam: `src/preflight.ts`, `src/critic/run.ts`, `test/preflight.test.ts`
   - model: opus — must reuse the exact production tool wiring or the canary lies

4. [ ] `volley matrix` subcommand — **done when:** `volley matrix --builders a,b --critics c,d --config …` runs the cross product serially, writes per-combo run state, and prints one aggregate table (iterations, wall clock, salvage rate, degraded flag) sourced from the `comparison` blocks; unit-tested with stubbed runs
   - seam: `src/cli.ts`, `src/matrix.ts`, `test/matrix.test.ts`, `README.md`
   - model: opus — new subcommand surface over existing orchestration

5. [ ] README refresh to v0.4.0 truth — **done when:** the local-builder section documents the shipped sandbox + `--worktree`, the flag table matches `src/cli.ts` exactly (including matrix), and the qwen3.6 critic caveat links `research/v3-comparison-finding.md`
   - seam: `README.md`, `CHANGELOG.md`
   - model: sonnet — mechanical reconciliation against cli.ts

6. [ ] Draft the upstream Ollama report — **done when:** `research/ollama-qwen-parser-issue.md` contains the minimal repro, the `qwen35.go`/`qwen3coder.go` log lines, and the degrade-to-text ask, ready to paste into a GitHub issue
   - seam: `research/ollama-qwen-parser-issue.md`
   - model: sonnet — distillation of an existing finding

7. [ ] Essayist example — **done when:** `examples/essayist/` (config, rubric criteria, custom critic prompt, prose brief) passes `--dry-run`, and a prose variant of the local harness-append exists if the builder preset proves code-toned
   - seam: `examples/essayist/`, `src/builder/presets/`
   - model: fable — the rubric/critic prompt is creative-judgment work

8. [ ] Capability-ladder examples — **done when:** `examples/ladder/` holds the seven probe workspaces — brownfield-bugfix (planted bugs + failing tests), feedback-convergence (vague prompt, strict criteria), cross-file-refactor, step-cap-pressure, dependency-wrangling, spec-compliance-parser, test-writing-seat — each with its own workspace seed, `volley.config.ts`, criteria, and check gate; each passes `--dry-run`; a ladder README states what each probes and the matrix line to sweep it
   - seam: `examples/ladder/`
   - model: fable — authoring seven distinct probe tasks with planted defects and calibrated criteria is design work

## Open questions

*(none open — Q1–Q3 resolved at the plan pause, Q4–Q10 resolved through
/pb-refine; see Verdicts.)*

## Verdicts

- 2026-07-17 — Q1 (essayist in/out) → **in**, and expanded: the capability-ladder
  builds are also authored as repo examples (new step 8) because "a list in a
  chat" isn't runnable; *running* the ladder stays out of scope.
- 2026-07-17 — Q2 (matrix repeat count) → **n=1** for the first cut; a
  `--repeat` flag can land later without schema changes.
- 2026-07-17 — Q3 (`--no-critic-fallback` opt-out) → **no flag**; the
  `critic_degraded` marker makes degradation visible and downstream consumers
  can treat it as failure themselves.
- 2026-07-17 — Q4 (error classification) → **spiked fascicle 0.9.5's error
  surface**: typed `provider_error` class with `kind` discriminant and
  `cause_kind` (`provider_5xx`/`network`/`unknown`); `schema_validation_error`
  and aborts are distinct classes/signals → D8, no string matching.
- 2026-07-17 — Q5 (builder retry) → **critic-only this build**; a builder
  stream death leaves a half-written workspace with state implications the
  critic doesn't have. Builder-phase retry parked as a follow-up OQ.
- 2026-07-17 — Q6 (canary design) → **canary must elicit a real tool call**;
  D5 amended, exact prompt/token budget decided at step 3.
- 2026-07-17 — Q7 (canary refuse vs warn) → **warn-and-predict**; exit 5 only
  for would-fail-even-degraded conditions → D5 amended.
- 2026-07-17 — Q9 (blind fallback) → **inject file inventory** (paths + sizes)
  into the tool-less fallback prompt → D9.
- 2026-07-17 — Q10 (example gates) → **no vale; plain node script gate** for
  the essayist; dependency-wrangling probe disclosed online-only → D10.
- 2026-07-17 — Q8 (matrix mechanics) → **git + forced `--worktree` per combo,
  summaries copied to `.volley-matrix/`, sweep-level exit semantics** → D11.
