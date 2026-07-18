# Report — volley v3 finish (fascicle 0.9.5 + sandbox/worktree)

*Synthesis over the `build-log.md` `## Log` timeline — the settled calls, the
final status, and the deferred work. The log is the step-by-step history; this
is the "yeah, I did that."*

## What shipped

Three things reconciled onto one path, in the plan's order (Session 0 → 2a → 2b
→ 2c):

- **Session 0 (steps 1–6)** — consumed the upgraded fascicle `0.9.5` on the
  existing `ai_sdk` transport by moving the whole peer set forward together
  (`ai@^7`, `ai-sdk-ollama@^4`), which resolved the v0.3.1 peer-major mismatch by
  construction. Retained all three v0.3.1 workarounds (base-URL normalizer,
  cold-load pre-warm, `num_ctx` warning), verified both critic-schema paths,
  passed live acceptance on ai_sdk, proved the native bridge once and reverted
  it, then merged `local-builder` → `main` (`90bf25f75`) so `main` held the
  known-good state before containment work.

- **Phase 2a — git worktree (steps 7–9)** — a worktree orchestration module
  (create / rotate-on-conflict / idempotent teardown), the containment root
  re-pointed to the worktree under `--worktree`, and `--git` checkpoints taken on
  the per-run phase branch with squash-merge on integration (D13).

- **Phase 2b — Docker sandbox, shape B′ (steps 10–13)** — a hardened `Dockerfile`
  carrying node/pnpm + the toolchain **and volley itself**; the containment shape
  landed as **whole-process (B′)**: volley runs *inside* one hardened container,
  invoked-in-container (B′-2), detecting containment rather than orchestrating it.
  The host-orchestrated `docker exec` path built in step 11 was deliberately
  retired in step 13 (bash returns to a local in-container `spawnSync`); the
  sandbox module survives as the pure invocation-spec / flag-builders the examples
  render. Default-deny egress (D12) with the host LLM endpoint reached across the
  boundary via `host.docker.internal`.

- **Phase 2c — preflight + examples (steps 14–16)** — `--sandbox` reframed from
  "refuse a local builder" to "require containment (or the opt-out)", a `--dry-run`
  preflight with the exit-5 contract, the two blessed examples, and the live run +
  written finding.

## Decisions and why (the calls behind the log)

- **Stay on `ai_sdk`; move the peer set forward together** (D1/D2/C5). Native was
  kept as a proven-once-then-reverted future bridge, not adopted — it keeps the
  transport a clean second variable for the comparison and gives the experiment a
  stable baseline.
- **Shape B′, invoked-in-container** (D5, resolved mid-build from the 2026-07-15
  re-examination). Containing the whole model-driven process — not just `bash` —
  closes the defense-in-depth gap shape B left open; invoked-in-container is
  minimal new volley code (containerization is the operator/example's job) and is
  what reshaped the safety gate from create → require. Docker Sandboxes' microVM
  evaluated and deferred as a future paranoid-mode backend (D14).
- **volley owns its containment; don't harden the CLI via fascicle** (D10). The
  all-Claude path stays Docker-free (C4), so the s2 D9 confound stays *disclosed*,
  not narrowed — which is exactly what the finding does.

## The build's own turn: live contact rewrote the last step

Step 16 was scoped as "run both examples + write the finding." Running them
surfaced that **five of seven blocking defects were harness/environment seams
that only manifest on first live contact** — most notably the step-8-deferred
check re-point that never landed (the check gated the workspace, not the
worktree, so any `--worktree` run could never converge) and pnpm 11's dep-verify
chatter breaking the `checkride --json` parse. Four out-of-seam repairs were
approved and folded into step 16 (tolerant parse + file fallback, check at
`build_root`, worktree `node_modules` inheritance, Dockerfile `pnpm-workspace.yaml`),
each with a test. This is why step 16 carries a 1431-minute clock and a drift
marker — the honest cost of first end-to-end contact.

**The finding itself** (`research/v3-comparison-finding.md`): the local model did
not get stuck on the *task* (iteration-parity with sonnet, more tests, ~3× wall
clock, $0) — it got stuck on the *protocol*, in one cell of the matrix. qwen3.6
as critic reproducibly (2/2) emits one mis-nested tool-call XML tag under the
tools+constrained-verdict combination; Ollama's `qwen35.go` hard-errors the
stream *server-side*, out of reach of volley's salvage layer. Every other critic
tested (qwen3:8b, gemma4:12b, glm-4.7-flash) converged. Attribution: the
malformed emission is the model's; the escalation from slip to fatal is the
serving stack's.

## Parked & harvested

Two items parked during step 16, both harvested at the closing boundary as
**tangents, deferred** (see `## Harvest`):

- **OQ-11** — phase-level bounded retry on provider stream errors.
- **OQ-12** — tool-less critic fallback.

They are design alternatives to each other (retry masks the stochastic slip;
tool-less fallback removes the failure surface), so they should be weighed
together, not built independently.

## Final status — done

All 16 planned steps checkpointed; `pnpm check` green at every gate; park list
and open questions both clear. The v3 comparison experiment ran live and is
written up with confounds disclosed (s2 D9).

**Deferred tangents / future work:**
- OQ-11 / OQ-12 as a robustness increment (critic stream-death resilience).
- A possible upstream Ollama report: `qwen35.go` should degrade a tool-XML parse
  failure to plain text (recoverable by client salvage) rather than hard-erroring
  the stream.

**Left for the human (outside plumbbob's scope):** merge `local-builder` → `main`
(the build branch is not yet merged), and the `/version` bump + changelog.

## Checkpoints

- baseline eee9d77cf4945845b16a6dfc96d8faf8e1f645c6
- plan 620be9f91ba6f91cc88fe676bd28a44fcf334bba
- step 1 b6a4f3c9936bf39c32f4970b60900e298a92242c
- step 2 809d042166ac3b2fc2459594e09533aa5ec005e7
- step 3 02637634ac2212f5a2f77dc021bef7bc729d4855
- step 4 22c43e82ced2e5abfbab3c487220c07d3f423cb3
- step 5 c4e23aa62dde4a4e344a586b65767ea585cf4f39
- step 6 90bf25f758c2d6bf6241bd3b5bc8597d3c31b76e
- step 7 c2fa9fa2248ef014e9ad1c9a9bd07ffaef9d212d
- step 8 627d6422c76f38b86a01ac1bc4d96f5cb5ac516b
- step 9 b21f692231125d0bb5b813d2ea45764ba8eecb25
- step 10 5f0727db93d2e10a160dce912b1ed048af0970ef
- step 11 5895dc7ba9408d5329859f252e1ece57c1786021
- step 12 55659b153b623a68c2708428f5147d948caac684
- step 13 20bbb3a3eeb4267fcfba241b42c22d77ae660dcb
- step 14 fc90e3fac9da9c77962027ca6906fd5a53cfd52f
- step 15 dda697b15fbd4927087ed88f8de4ba80c50ddc5d
- step 16 08998144adbe9975844cbe7c836057fe39c9fb1b

## Stats

| step | red checks | drift warnings | reverts | wall-clock |
|------|------------|----------------|---------|------------|
| 1 | 0 | 1 | 0 | 7m |
| 2 | 0 | 0 | 0 | 5m |
| 3 | 0 | 0 | 0 | 8m |
| 4 | 0 | 0 | 0 | 21m |
| 5 | 0 | 0 | 0 | 61m |
| 6 | 0 | 0 | 0 | 2m |
| 7 | 0 | 1 | 0 | 6m |
| 8 | 0 | 1 | 0 | 32m |
| 9 | 0 | 1 | 0 | 16m |
| 10 | 0 | 1 | 0 | 16m |
| 11 | 0 | 1 | 0 | 176m |
| 12 | 0 | 1 | 0 | 436m |
| 13 | 0 | 1 | 0 | 22m |
| 14 | 0 | 1 | 0 | 25m |
| 15 | 0 | 1 | 0 | 15m |
| 16 | 0 | 1 | 0 | 1431m |
| **total** | 0 | 11 | 0 | 2277m |
