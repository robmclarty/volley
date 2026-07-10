# Build report — volley v3 s1: local builder tool loop

**Status:** complete — 10/10 steps checkpointed (baseline `c3944f7` → step 10 `14001f5`).
**Source plan:** `intent.md` (author-converged spec `volley-spec-v3-s1-local-builder.md`, 2026-07-07).

## What shipped

`builder_provider: ollama | lmstudio` was inert — the plumbing existed but
`run_builder` hardwired `claude_cli`. This build made the local builder live:
volley now supplies the whole agentic surface a local model lacks and drives it
through one bounded fascicle tool loop per iteration, terminated by an explicit
`finish` or the `max_steps` backstop. The resulting workspace is handed to check
+ critic identically to a `claude_cli` build.

The `## Log` carries the step-by-step timeline; the shape of what landed:

- **Config + safety** (steps 1–2) — `--builder-max-steps` (default 50) threaded
  through resolve → persist → restore, and the D11 refusal that blocks a local
  builder *before any model spend* unless `--allow-unsandboxed-builder` opts out.
- **Tool surface** (steps 3–5) — a shared `workspace_tools` module (the three
  read tools hoisted out of the critic without a deep-sibling import, C4), plus
  `write_file`, `edit_file` (exact-match-or-fail, D10), `bash` (stateless,
  never-throw, D3/D4), `fetch` (readability pipeline + connector-level SSRF, D9),
  and a terminal `finish` (`ends_turn: true`, D6).
- **Wiring + prompt** (steps 6–7) — the local system prompt (D12) and
  `run_builder`'s local branch with the five per-call loop knobs and no schema
  (C5), proven to leave the `claude_cli` arm byte-for-byte unchanged (C3).
- **Observability + cost** (steps 8–9) — D7 termination surfacing (max_steps
  warning + salvage-rate metric in the iteration summary) and the D13 `$0`/`null`
  cost-cap verification.
- **Live path + docs** (step 10) — a `VOLLEY_LIVE`-gated local-builder smoke
  test, the README `## Local builder` section, and a real num_ctx warn.

## Decisions and why

- **D1/D6 — one `generate` call, `finish` as a hard stop.** The inner tool loop
  lives inside a single `engine.generate`, so it can't perturb the outer loop's
  round accounting, and fresh-context-per-iteration is preserved. fascicle
  0.8.16's `ends_turn` affordance made `finish` a deterministic, weak-model-proof
  stop rather than the 0.8.13 soft signal.
- **D7 — a `max_steps` cutoff is data, not an error.** The partial workspace goes
  to check + critic like any iteration; the cutoff surfaces as a warning +
  recorded `finish_reason`, keeping v2's "non-convergence is data."
- **D11 — unsandboxed local builder refused by default.** A local model gets a
  real host `bash` before the container exists, so the refusal (opt-out only)
  ships as the guard until Session 2's sandbox lands.
- **D13 — verification found no gap.** `$0` records as `0` (only a *missing* cost
  is null), and the cap predicate is `>=` against a strictly-positive cap, so an
  all-local free run never trips or disables it. No guard was added — the step
  stayed tests-only, as planned.
- **C4 — shared module over a fork.** The `../critic/tools.js` import the plan
  first assumed is rule-blocked (`no-deep-sibling-import`), so the read tools
  moved to `src/workspace_tools.ts` and both roles import from there.

## Parked & harvested

Neither parked item was acted on inline (correct — capture, don't chase). Both
classify as **tangent** (a different path, not a failed assumption), deferred:

1. **Upstream fascicle guardrail** — block a successful `finish` when a tool call
   failed earlier in the same turn (Roo's `didToolFailInCurrentTurn`, guards the
   weak-model "error → shrug → finish" pattern). This is loop-state, so it lives
   in fascicle's domain, not volley's — a feedback candidate for fascicle, not a
   volley change.
2. **Flag-gate `fetch` off by default** — research cuts against always-on (absent
   from strong minimal harnesses; the 8-tool surface sits at the measured Qwen
   degradation edge, goose #6883). D8 stays locked (fetch ships); only the
   *default* is open. A human boundary call, not a build task.

## Final status

Done. All ten steps are green under `plumbbob check` (types, lint, struct, dead,
test, links). One scope note: step 10 widened its stated test+README seam to add
`src/builder/context_check.ts` and a hook in `src/builder.ts` for the num_ctx
warn — an authorized in-session decision ("implement the warn now"), not drift.

## Deferred tangents (future work)

- The two parked tangents above (fascicle `finish`-guardrail; `fetch`-default gating).
- **Open questions from the spec**, to resolve from live-run mileage: Q1 cap
  defaults (`builder_max_steps`, `BASH_TIMEOUT_MS` vs the 600s checkride budget,
  fetch caps), Q2 `edit_file` lint-on-edit, Q3 line-windowed `read_file`, Q4 the
  Tier-2 text-protocol transport (spike only if native + salvage proves
  insufficient). Q5 (config version vs default-on-restore) was settled in step 1.
- **Session 2** (`volley-spec-v3-s2-sandbox-worktree.md`) — the container/worktree
  sandbox that turns the D11 opt-out into the devcontainer escape hatch, swaps
  `bash`'s `subprocess.run` for `docker exec` at the unchanged tool seam (D3),
  and lands the blessed comparison `examples/`.

## Checkpoints

- baseline c3944f7c3c46cbd3aed04ef2bcd391741719263a
- plan d3d59b647bcd23d35b3d47c33ce7bc1e62c09f30
- plan bd96a7756de682da100d575b5a58e04f1b2ff639
- step 1 48559a9717bcbdf653d22fa0b63f962e32e0e083
- step 2 02a02e030ca0e8842cec32c49ecd89e28d83ff49
- step 3 5194f88b023a1ac6aef95a8c87a55eb2358abf19
- step 4 8c1a6b0db083e4f4d100109e134713ad4888e97b
- step 5 cc24adcb087bca1449dfd2a59516931cd4a32c6a
- step 6 913a8a2e88f5c92d29cd52b96c60a95e5fa6be12
- step 7 c8dbbe46fc2794011e1ffdc734ec35c00caaccff
- step 8 a3616eff229344c360bd4823ea49ec9302d2f029
- step 9 c02a76f47569843ea625f5328fad579fc5fcb491
- step 10 14001f5f6d2017b3614ff72fe3631eab3aea9d8e
