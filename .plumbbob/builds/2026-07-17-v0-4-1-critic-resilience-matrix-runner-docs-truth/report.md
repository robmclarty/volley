# Report — v0.4.1 — critic resilience, matrix runner, docs truth

*Build folder: `.plumbbob/builds/2026-07-17-v0-4-1-critic-resilience-matrix-runner-docs-truth/`.
Steps 1–10, all checkpointed. See `## Log` in `build-log.md` for the dated
per-step timeline; this report is the synthesis, not a re-narration.*

## What shipped

The v0.3.0 comparison proved the all-local path works end-to-end but exposed a
fragile critic seat: qwen3.6-as-critic reproducibly dies on Ollama's server-side
tool-XML parser, killing a run *after* the builder did perfect work, with nothing
in preflight to catch the doomed combo before spend. This build makes that seat
degrade instead of die, adds a runner for finding good pairings, and brings the
docs to shipped truth. Four threads, ten steps:

- **Critic resilience (steps 1–3).** A degradation ladder in `src/critic/run.ts`:
  a bounded retry-with-tools on a local-provider stream death (OQ-11), then a
  tool-less fallback that still returns a schema-valid verdict marked
  `critic_degraded` (OQ-12), and a `$0` critic-seat canary at `--dry-run` that
  fires a real tool call through the production wiring to predict a doomed combo
  before any builder spend. OQ-11 and OQ-12 — parked since v0.3.0 — are resolved.
- **Matrix runner (step 4).** A `volley matrix` subcommand sweeps the
  builder×critic cross product serially over one fixed config and emits a single
  aggregate table from the existing `comparison` blocks — replacing hand-edited
  model flags on a per-combo `docker run` line.
- **Docs truth (steps 5, 10).** The README now documents the shipped sandbox +
  `--worktree`, its flag table reconciled against `src/cli.ts` rather than memory,
  and the matrix example points at a real committed config.
- **Examples & upstream report (steps 6–9).** A drafted Ollama parser issue
  (`research/`), an essayist example proving critic-swap generality, seven
  capability-ladder probe workspaces, and an `src/sandbox.ts`-accurate online-only
  run recipe for the dependency-wrangling probe.

## Decisions and why

- **Degrade, don't refuse (D1–D5).** The ladder order is retry-with-tools once →
  tool-less fallback → fail, *because* the stream death is stochastic (a same-call
  retry may pass) and a full-tools critique is strictly richer — give it one chance
  before trading read access for survival. A degraded verdict is *always* marked
  (`critic_degraded`) so it never passes silently as a full one, and the fallback
  keeps constrained decode (schema is the part that works; only the tool surface
  hits Ollama's broken parser). The `--dry-run` canary therefore **warns and
  predicts** rather than exiting 5 — the ladder means the combo survives a real
  run, so refusing it would contradict step 2. Exit 5 stays for conditions that
  fail even degraded (endpoint down, model missing).
- **Local providers only (D2).** The ladder is scoped to `ollama`/`lmstudio`; the
  `claude_cli` critic path is proven, has different failure modes, and its retries
  cost real money.
- **Typed errors, no string matching (D8).** The ladder triggers on fascicle's
  typed `provider_error` (`err.kind`, guarded by `!abort.aborted`); schema
  validation stays exit-6, aborts stay exit-130.
- **Matrix reuses existing machinery (D6, D11).** A subcommand — not a bash
  wrapper — reuses `resolve_config` and worktree teardown; serial execution
  because local combos share one GPU and would thrash the loader in parallel. It
  requires a git workspace and forces `--worktree` per combo for a clean reset;
  a non-converging combo is a *result* in the table, not a sweep failure.
- **Docs verified against the binary (D7); examples stay dependency-free (D10).**
  README truth reconciled against `src/cli.ts` because the drift being fixed came
  from documenting intent instead of shipped flags; example gates are plain node
  scripts (no vale), and the dependency-wrangling probe is disclosed online-only
  because the sandbox's egress is deny-by-default.

## Parked & harvested

One item was parked during the build and is now closed:

- **tangent** — the README matrix example pointed `--config` at the nonexistent
  `./examples/local-loop/`. A docs defect noticed mid-build, not a plan flaw.
  Rather than defer it, it was folded into the plan as **step 10** and shipped
  (repointed to the real, committed `./examples/essayist/volley.config.ts`;
  `links` gate green). Nothing left dangling.

## Final status

**Done.** All 10 planned steps checkpointed; `pnpm check` (checkride: types, lint,
struct, dead, test, links) green throughout, including the final checkpoint. No
open questions, no unharvested parked items. Not a release — the version bump and
changelog are the human's `/version` call.

## Deferred tangents (future work)

Scoped out by design in `intent.md` ("Explicitly NOT doing"), now the backlog:

- **File the Ollama issue.** Step 6 *drafts* the report; filing it upstream is the
  human's external action.
- **Builder-phase stream-death retry** (Q5). This build is critic-only; a builder
  stream death leaves a half-written workspace with state implications the critic
  doesn't have — parked as a follow-up OQ.
- **Native Ollama transport flip** (OQ-6) — the bridge trigger is unchanged.
- **Run the capability-ladder experiments.** Step 8 *authors* the seven probes as
  runnable artifacts; actually sweeping them through the matrix runner is
  post-build usage.
- **The plumbbob build-slot agent integration** — a separate future build.

## Checkpoints

- baseline 2dda78173ec215da3c1e07d2a7c4bced40c23916
- plan 0df95bff36a872aad183b1b37d49a6d1676c6a8e
- plan 936f2c665ee73daacb79652d66627f4c0efc2177
- step 1 5d0a5f8f033f0692f1aad7bd991b5e441e29d508
- step 2 bb7fedac49a893bc586ed2a1293b3600b4583a9b
- step 3 d476dd3db004a25fdf6e1a96405dc1a2146b2419
- step 4 3d5c05eb61617cc89cb8c9c005a39e836c9d4e26
- step 5 38436fa9278152aaca24001acddfbd427a776aca
- step 6 f475bc3a779611c0ed4b7003ee38e06d39aed982
- step 7 9ea0881fb1f2a16f4f68fd47f0d027bea5425d1d
- step 8 57db30e63d9c9889242e6e07727dd4323b2d0d47
- step 9 01890538a520040a3c5c84959418e6d78beae96f
- step 10 7d6496710c0b9c8372843e093c959a707d737892

## Stats

| step | red checks | drift warnings | reverts | wall-clock |
|------|------------|----------------|---------|------------|
| 1 | 0 | 1 | 0 | 9m |
| 2 | 0 | 1 | 0 | 88m |
| 3 | 0 | 1 | 0 | 11m |
| 4 | 0 | 1 | 0 | 17m |
| 5 | 0 | 0 | 0 | 7m |
| 6 | 0 | 0 | 0 | 4m |
| 7 | 0 | 0 | 0 | 19m |
| 8 | 0 | 0 | 0 | 4m |
| 9 | 0 | 0 | 0 | 3m |
| 10 | 0 | 0 | 0 | 2m |
| **total** | 0 | 4 | 0 | 165m |
