# volley v3 — Reconciled finish spec: fascicle 0.9.5 + sandbox/worktree

A plan-ready specification that reconciles three things into one path to "v3 done":

1. **What shipped** — Session 1 (the local builder tool loop) is merged and live-tested
   as **v0.3.1**, including the out-of-box fixes that release made
   ([`../../CHANGELOG.md`](../../CHANGELOG.md): Ollama base URL, cold-load pre-warm,
   peer-major docs).
2. **What changed under us** — the user upgraded the **fascicle** source repo from
   `0.8.16` → **`0.9.5`**, which lands two breaking changes (AI SDK v7 peers; a native
   provider transport) plus new loop knobs. volley's `node_modules` still pins `0.8.16`,
   so consuming `0.9.5` is itself part of finishing.
3. **What's left** — Session 2 (Docker sandbox + git worktree containment) and the two
   blessed comparison examples, per
   [`volley-spec-v3-s2-sandbox-worktree.md`](./volley-spec-v3-s2-sandbox-worktree.md).

This document supersedes the *scheduling* of s1/s2 (it inserts a Session 0 upgrade phase
ahead of s2) but **preserves every locked s2 decision** and keeps the v0.3.1 local-path
fixes in place.
Everything true in [`volley-spec-v2.md`](./volley-spec-v2.md) and the s1 spec carries
forward. Where this doc and the v3 refinement draft
([`volley-spec-v3.md`](./volley-spec-v3.md)) disagree on containment or transport, this doc
wins.

---

## Context — why this reconciliation exists

The s2 spec was written against fascicle **0.8.13–0.8.16**, where the only way to reach a
local model was the **AI SDK transport** (`ai-sdk-ollama` / `@ai-sdk/openai-compatible` as
peers). That transport is what forced v0.3.1's three local-path fixes, and its peer-major
coupling is what broke the local builder out of the box (`ai-sdk-ollama` v4 vs fascicle's
`^3` range; undici's ~300s in-request timeout killing a cold model load).

fascicle **0.9.5** matters here for two reasons. First, it moves the whole peer set to the
**AI SDK v7 line**, which — moving fascicle, `ai`, and `ai-sdk-ollama` forward *together* —
resolves the v0.3.1 peer-major mismatch by construction (`ai-sdk-ollama@^4` is exactly what
`ai@^7` wants). Second, it adds a **native, raw-HTTP transport** to Ollama's own `/api/chat`
with **zero `@ai-sdk/*` in the module graph** — which *would* retire the remaining v0.3.1
workarounds, but is **deliberately deferred** here: the `ai_sdk` transport is doing its job,
so native is kept as a ready one-line flip for when we choose to cross that bridge. The
upgrade still comes *before* s2, because s2's "all-local, offline, $0" example stands on a
working local transport and the peer set must move as a unit.

The intended outcome: a volley that (a) runs on fascicle 0.9.5 on the **existing `ai_sdk`
transport** (peers moved to the v7 line, v0.3.1 fixes retained), then (b) contains the local
builder in a Docker sandbox over a git worktree, and (c) ships the two comparison examples
that prove v3 — with the native transport documented as a deliberate, cheap future option.

---

## What fascicle 0.9.5 changes for volley (the delta that reshapes the plan)

All verified against the fascicle source at `~/Projects/fascicle/code/fascicle` @ 0.9.5.

| Change (fascicle version) | Evidence | Consequence for volley |
|---|---|---|
| **Native Ollama transport** on `/api/chat` (0.9.2) | `src/engine/providers/ollama_native.ts` — `base_url` is the **daemon root**, adapter appends `/api/chat` (L528, L536); "Zero `ai`/`@ai-sdk/*` in the module graph". | **Future option, not adopted now.** volley's v0.3.1 base-URL fix (server root) is already correct for native too, so flipping later needs no re-pointing. On native, `ai-sdk-ollama` would not be imported. |
| **Transport selector** `transport?: 'ai_sdk' \| 'native'` on the provider config, **defaults to `'ai_sdk'`** (0.9.2) | `src/engine/providers/types.ts:36-48`; `ProviderConfigMap.ollama: { base_url; transport? }` at `src/engine/types.ts:319`. | The default (`ai_sdk`) is what volley wants — **no `transport` field needed**. The one-line flip to `'native'` is documented in R2 as the future bridge. |
| **AI SDK v7 peers** (0.9.0), all provider SDKs **optional** | fascicle `package.json`: `ai: ^7.0.0` (required), `ai-sdk-ollama: ^4.0.0` + `@ai-sdk/openai-compatible: ^3.0.0` (both `optional: true`). | volley bumps `ai` `6.0.219 → ^7` **and** `ai-sdk-ollama` `3.8.8 → ^4` (staying on ai_sdk). Moving fascicle + `ai` + peer forward together is what resolves the v0.3.1 mismatch. |
| **`provider_options.ollama` raw passthrough** — `options` (incl. `num_ctx`), `keep_alive`, `format`, `think` (0.9.2) | `ollama_native.ts:140-151` (shallow-merged; a passthrough `options` bag replaces the derived one wholesale). | A **native-path** capability (set `num_ctx`/`keep_alive` per-call). On the ai_sdk path volley keeps its existing `num_ctx` warning; noted as a benefit available if/when native is adopted. |
| **`turn_timeout_ms`** per-turn budget, **default unbounded** (0.9.2) | `src/engine/types.ts:257-264`. Native `invoke_turn` uses a bare `fetch(..., { signal: req.abort })` with **no** default body timeout (`ollama_native.ts:533-546`). | Explains the v0.3.1 cold-load death (`stream interrupted: fetch failed` at ~300s) as an **ai-sdk/undici default** — which is why, staying on ai_sdk, the **pre-warm stays** (R3). Native would remove it; kept as future context. |
| **`prepare_step` hook** — per-turn message reshaping without mutating the transcript (0.9.2) | `src/engine/types.ts:222-244, 286-294`. | Optional lever for long builder loops on small-context local models (windowing). Not required for v3. |
| **`subprocess` → `external` provider rename** (0.9.2, breaking) | CHANGELOG v0.9.2. | **No volley impact** — volley uses the separate `claude_cli` provider, never `subprocess`. |
| **`claude_cli` structured-output fix** (0.9.5) | `compile_schema` strips top-level `$schema`/`$id` that zod v4 stamps, which `claude --json-schema` rejects — `src/engine/providers/claude_cli/adapter.ts:152-157`. | volley's **critic schema on the `claude_cli` path now works end-to-end** on 0.9.5. Verify-only, no code change. |
| **`custom_providers` open registry** (0.9.2) | `ProviderConfigMap` / `EngineConfig`. | Not needed by volley; noted for completeness. |

**Headline (decided).** volley **stays on the `ai_sdk` transport** for now — it is doing its
job, and the native path is kept as a ready-to-flip option for when we choose to cross that
bridge (a one-line change in `src/engine.ts`, documented below). The immediate win from 0.9.5
is simpler than "go native": bumping fascicle, `ai`, **and** `ai-sdk-ollama` forward *together*
(to the v7 line) **resolves the peer-major mismatch by construction** — the original v0.3.1
breakage was `ai-sdk-ollama@4` (v7-spec) against fascicle 0.8.16's `ai@6`/`^3` range; on
fascicle 0.9.5 (`ai@^7`), `ai-sdk-ollama@^4` is exactly right. Because the whole peer set must
move together and s2's all-local example stands on a working local transport, this is still
**Session 0**, ahead of the containment work — but it's a version-forward step on the same
transport, not a transport migration. The v0.3.1 workarounds (base-URL normalizer, cold-load
pre-warm, `num_ctx` warning) **remain load-bearing on the `ai_sdk` path** and are kept.

---

## Sessions & phases

### Session 0 — fascicle 0.9.5 on the ai_sdk transport (the prerequisite)

**Goal.** Consume fascicle 0.9.5 on the **existing `ai_sdk` transport**, moving the whole
peer set (`ai`, `ai-sdk-ollama`) forward to its v7 line so the v0.3.1 peer-major mismatch is
resolved by construction. Keep the native transport as a documented, ready-to-flip option.
No new user-facing feature — this is the floor s2 stands on.

**R1 — Bump dependencies together; keep `ai-sdk-ollama`.** `package.json`:
`fascicle 0.8.16 → 0.9.5`, `ai 6.0.219 → ^7`, **`ai-sdk-ollama 3.8.8 → ^4`** (all exact-pinned
per house style). Keeping the peer is deliberate — the ai_sdk transport is doing its job, and
the v7-line `ai-sdk-ollama@^4` is exactly what fascicle 0.9.5's `ai@^7` wants, so moving all
three forward *together* closes the v0.3.1 breakage rather than routing around it. Update
README's peer table + `.env.example` to say `ai-sdk-ollama@^4` (was `@^3`). If a user later
opts into the native transport, the peer becomes unnecessary — note that, don't act on it.

**R2 — Keep the ai_sdk transport; document the native flip as the future bridge.** No
`transport` field is added — the provider config default (`ai_sdk`) is what volley wants, so
`local_provider_config` (`engine.ts:67-75`) is unchanged except for the dependency bump.
Record in a short code comment (and here) that flipping to native later is a **one-line
change** — add `transport: 'native'` to the `ollama`/`lmstudio` configs — and that
`resolve_ollama_base_url` already produces the daemon-root URL native also wants, so no
re-pointing is needed when we cross that bridge. This keeps the option cheap without spending
it now.

**R3 — Keep the v0.3.1 local-path workarounds; they remain load-bearing on ai_sdk.** Staying
on the ai_sdk (`ai-sdk-ollama`/undici) transport, the three v0.3.1 fixes stay exactly as
shipped: the base-URL normalizer (`resolve_ollama_base_url`), the `num_ctx` warning
(`builder/context_check.ts`), and the cold-load **pre-warm** (`src/prewarm.ts`). The pre-warm
is **kept** — it is what stops a cold multi-GB model from tripping undici's ~300s in-request
timeout with `stream interrupted: fetch failed`, which is a live failure mode on this
transport. **Add a note** (code comment on `prewarm_ollama_model` + a line in README's local
guide) that its necessity **drops away on the native transport** — native uses a raw `fetch`
with no in-request timeout, so the cold load just waits for the first byte — and that
`num_ctx`/`keep_alive` would then move to `provider_options.ollama`. This records the reduced
future necessity (per the decision) without removing anything now.

**R4 — Local critic schema stays on constrained decode (ai_sdk).** On the ai_sdk transport
Ollama advertises `structured_output` (native constrained decode via its `format` field), so
the local critic's `verdict_schema` keeps constrained decode — good for weak models — with no
change. (This is the arm that would move to prompt+parse+repair *if* volley went native, at
which point set `schema_repair_attempts > 0` or pass `provider_options.ollama.format`. Parked
as OQ-0, native-only.)

**R5 — Verify the `claude_cli` critic schema path.** The 0.9.5 `compile_schema` fix
(`claude_cli/adapter.ts:152-157`, strips `$schema`/`$id`) means the all-Claude critic's
`verdict_schema` now compiles for `claude --json-schema`. No code change; add/keep a live
assertion so a future fascicle regression is caught.

**Done when.** `pnpm check` green on fascicle 0.9.5 with `ai@^7` + `ai-sdk-ollama@^4`; the
`VOLLEY_LIVE` local-builder smoke test passes on the ai_sdk transport (peer-major mismatch
resolved); a cold large model still succeeds via the retained pre-warm; the all-Claude live
path (builder + critic schema, now unblocked by the 0.9.5 fix) passes.

**Seams:** `package.json` + `pnpm-lock.yaml` (dep bumps), `src/engine.ts` (dependency bump
only + a native-flip comment; `resolve_ollama_base_url` unchanged), `src/prewarm.ts` +
`src/builder/context_check.ts` (kept; add the reduced-necessity note), README + `.env.example`
(peer `@^4`), and the live test (`test/integration/live_smoke.test.ts`) re-run to confirm the
upgrade end-to-end.

---

### Session 1 — DONE (v0.3.1)

The local builder tool loop is merged and live-tested. Recorded here only so the finish
plan is self-contained; no further work except what Session 0 revises. Key shipped seams the
later sessions build on: the stateless `bash` tool (`spawnSync`, `src/builder/tools.ts:463-504`),
`contain()` (`src/workspace_tools.ts:35-43`), `builder_tools()`, and the
`--allow-unsandboxed-builder` refusal (`src/config.ts:230-237`).

---

### Session 2 — Docker sandbox + git worktree (the remaining feature)

Unchanged in design from
[`volley-spec-v3-s2-sandbox-worktree.md`](./volley-spec-v3-s2-sandbox-worktree.md) — all ten
decisions carry forward verbatim (summarized below, with the reconciliation deltas Session 0
introduces). Split into two shippable phases plus the examples.

#### Phase 2a — git worktree (isolates *effects*)

A phase = a worktree = a branch: the builder's writes become a branch that can be diffed,
checkpointed per phase (extends v2 `--git`), and discarded wholesale (s2 D2, `[locked]`).

- **Re-point `contain()`'s root to the worktree path** (s2 D3): `write_file`/`edit_file`/read
  tools already resolve through `contain()` (`workspace_tools.ts:35`), so the containment
  root simply becomes the worktree — no new guard logic.
- **New worktree orchestration**: create/rotate/tear-down, invoked by the orchestrator around
  the builder phase. **Rotate on conflict** (s2 D4), mirroring `initialize_workspace`'s
  `.volley.bak.<ts>` rotation (`workspace.ts:21-31`). Any added iteration must still use
  fascicle's `loop` — the `orchestrator-no-loops` rule forbids hand-written iteration in
  `src/orchestrator.ts`.
- **Interacts with existing `--git`**: today `git_checkpoint` (`workspace.ts:63-82`) commits
  the whole workspace in place, twice per iteration (`orchestrator.ts:156-158, 226-231`).
  Under a worktree, checkpoints are taken on the **worktree branch** (s2 D4; exact semantics
  = OQ-4). `--git`'s existing `.git` pre-check (`config.ts:248-250`) is the precedent guard.
- **`--worktree` flag** + config field, persisted in `.volley/config.json` and restored on
  resume, defaulting like `builder_provider` does.

#### Phase 2b — Docker sandbox (isolates *blast radius*), shape (B)

volley (Node, model client, tools) stays on the **host** — keeping native local-provider
access trivial — and only the `bash` tool's commands run via `docker exec` against a
container that bind-mounts the worktree (s2 D1, `[author-locked lean]`).

- **The one load-bearing swap**: the `bash` executor changes from host `spawnSync`
  (`src/builder/tools.ts:479-503`, self-documented at L473-478 as this exact seam) to
  `docker exec` (or exec against one long-lived `docker run` per run — OQ-1). **Tool contract
  unchanged**; stateless-per-command means no cwd/env drift (s2 D1/D3). File writes land
  host-side in the bind-mounted worktree, so `bash` sees identical files (s2 D3 — resolves v3
  draft §12 Q2).
- **Ship a `Dockerfile` + default image** with node/pnpm and the workspace dev toolchain so
  the builder can self-run `pnpm check`/checkride (s2 D5). `--sandbox-image <tag>` overrides.
  **The all-Claude path must not require Docker.**
- **Network policy: default-deny egress** except what the run needs (s2 D6); a fully offline
  all-local run disables `fetch` cleanly (s1's `fetch` already degrades to a returned error).
  The tool-level SSRF deny-list (s1) + container policy are defense in depth.
- **`--sandbox` flag**: **default-on for a local builder**, forbidden/no-op for `claude_cli`.
- **Reframe the safety gate.** With the sandbox default-on, `src/config.ts:230-237` flips
  from "refuse a local builder" to "refuse a local builder **only when neither `--sandbox`
  nor `--allow-unsandboxed-builder` is in effect**." `--allow-unsandboxed-builder` becomes the
  **shape-C escape hatch** ("I already run in a devcontainer") — still prints the loud
  `cli.ts:81-89` warning, skips volley's own Docker orchestration (s2 D1).

#### Phase 2c — preflight + the two blessed examples

- **`--dry-run` preflight** mirrors `checkride doctor` (s2 D7): before any model spend, check
  `docker` available, image present (build/pull per policy), worktree creatable, local
  endpoint reachable. Docker unavailable / image missing → **exit 5**, never on the
  all-Claude path.
- **The two comparison examples** are the v3 deliverable (s2 D10, `[locked]`):
  - **all-Claude** — `builder_provider: claude_cli`, `critic_provider: claude_cli`; no Docker.
  - **all-local** — `builder_provider: ollama` (pinned tool-capable build, e.g. a Qwen3 ≥ 8B
    whose dialect matches the runtime parser), `critic_provider: ollama`, `ai_sdk` transport
    (the current default), checkride gate, Docker sandbox + worktree, `fetch` enabled; targets
    **$0, offline**.
  - `examples/local-critic/` (Claude builder + local critic) stays as the mixed midpoint.
  - Both run the **same phase-sized task, same criteria, same checkride gate, same caps** —
    only the provider differs. **Disclose the confounds honestly** (s2 D9): the containment
    mechanisms differ (fascicle `claude_cli` `sandbox` bwrap/greywall vs volley Docker), the
    tool surfaces differ (CLI built-ins vs volley tools), `fetch` ≠ `WebFetch`. The finding to
    record is *where the local model got stuck, and whether it was the model or the
    transport*. (Both examples run the ai_sdk transport, so the AI-SDK layer is a shared,
    not differential, factor — if we later flip the local path to native, re-run to see
    whether it was the transport.)
  - Comparison data already in `.volley/summary.json`: iterations-to-converge, wall-clock,
    cost, verdict, check trajectory, plus the local **salvage rate** and **transport used**.

---

## Decisions carried forward (s2 D1–D10) + reconciliation deltas

D1–D10 from [`volley-spec-v3-s2-sandbox-worktree.md`](./volley-spec-v3-s2-sandbox-worktree.md)
are unchanged. The deltas this reconciliation adds:

- **Δ1 (transport unchanged; version forward).** The local transport **stays `ai_sdk`**; 0.9.5
  is consumed by moving the peer set to the v7 line (Session 0 R1). The native transport is a
  documented future option (R2), not part of this plan. s2 D9's confound is therefore
  unchanged from what s1 assumed.
- **Δ2 (v0.3.1 workarounds retained).** Base-URL normalizer, cold-load pre-warm, and the
  `num_ctx` warning all stay, because they address ai_sdk-path behavior (R3). The spec records
  their reduced necessity under a future native flip; it does not remove them.
- **Δ3 (verify, don't build).** The `claude_cli` critic schema path is fixed upstream in
  0.9.5 (R5) — an assertion, not a change.
- **Δ4 (s2 D8 unchanged).** The checkride double-run stays a documented all-local cost; the
  artifact-verification fix remains out of scope for v3.

---

## Failure modes (extends s1 / v2 §9)

| Scenario | Expected behavior |
|---|---|
| fascicle 0.9.5 present but `ai@^7` / `ai-sdk-ollama@^4` missing or mismatched | Install/peer error at build; caught by `pnpm check` before any run. Moving all three forward together is what avoids it. |
| Ollama daemon down (ai_sdk transport) | Surfaced as a builder/provider error (exit 3) after the retry policy. |
| Cold large model load (ai_sdk transport) | The retained pre-warm loads the model before the first real turn, keeping it under undici's in-request timeout. (Native would make this a non-issue — future.) |
| Docker unavailable / image missing (local builder, `--sandbox`) | Preflight/config error → **exit 5**, before model spend. Never on all-Claude. |
| Worktree exists / dirty | Rotate aside + log (s2 D4). |
| `bash` tries to escape the container | Contained by the sandbox — the write lands in the container/worktree only. |
| `fetch` blocked by sandbox network policy | Error returned to the model as a tool result; run continues. Offline run disables `fetch` cleanly. |

---

## Seams (files this finish touches)

- **`package.json`** — fascicle 0.9.5, `ai@^7`, `ai-sdk-ollama@^4` (kept; Session 0).
- **`src/engine.ts`** — `transport: 'native'` for local providers; keep `resolve_ollama_base_url`.
- **`src/builder.ts` / `src/critic/run.ts`** — `provider_options.ollama` (`num_ctx`,
  `keep_alive`), `schema_repair_attempts` on the local critic.
- **`src/prewarm.ts` / `src/builder/context_check.ts`** — thin/remove; demote to diagnostic.
- **`src/builder/tools.ts`** — `bash` executor `spawnSync` → `docker exec` (Phase 2b);
  `contain()` root → worktree (Phase 2a, via the read/write tools).
- **New sandbox/worktree orchestration module(s)** — create/rotate worktree, build/pull/start
  container, tear down; invoked around the builder phase by `src/orchestrator.ts` (respecting
  `orchestrator-no-loops`).
- **`src/config.ts` / `src/cli.ts`** — `--sandbox`, `--sandbox-image`, `--worktree`,
  `VOLLEY_SANDBOX_*`; reframe the `--allow-unsandboxed-builder` gate.
- **`src/workspace.ts` / `src/iteration.ts` / `src/types.ts`** — persist + restore the new
  fields; worktree-branch checkpoints.
- **`Dockerfile`** (new) + **`examples/all-local/`, `examples/all-claude/`** (new).
- **`checkride.config.json` / `rules/`** — respect all 8 ast-grep rules
  (`create-engine-only-in-engine`, `no-class`, `no-deep-sibling-import`, `no-default-export`,
  `no-pricing-constants`, `no-this`, `orchestrator-no-loops`, `require-js-extension`).

---

## Open questions (park — none blocks planning)

- **OQ-0 (native-only, parked).** *If/when* volley flips to the native transport: local critic
  verdict via prompt+parse+repair (`schema_repair_attempts`) vs Ollama constrained decode via
  `provider_options.ollama.format`. Moot while on ai_sdk (constrained decode is the default
  there).
- **OQ-1.** Persistent container vs per-command `docker run` (both satisfy stateless `bash`;
  long-lived + `docker exec` is the likely speed pick).
- **OQ-2.** Exact container CPU/memory caps and the network allowlist shape.
- **OQ-3.** Whether a local `--sandbox` run should also harden the CLI builder via fascicle's
  `claude_cli` `sandbox` (bwrap/greywall), narrowing the D9 confound.
- **OQ-4.** Exact semantics of `--git` checkpoints taken on the worktree branch.
- **OQ-5 (deferred, decided-for-now).** `src/prewarm.ts` is **kept** while on the ai_sdk
  transport (it prevents the cold-load timeout there). Revisit — likely delete in favor of
  `keep_alive` — only if/when volley adopts the native transport.
- **OQ-6 (the bridge trigger).** What would make us flip `ollama`/`lmstudio` to
  `transport: 'native'`: dropping the `ai-sdk-ollama` peer, per-call `num_ctx`/`keep_alive`,
  and no cold-load timeout are the carrots; the cost is the local critic moving off constrained
  decode (OQ-0). Not this cycle.

  **Why ai_sdk first, deliberately (not just deferral discipline).** Native's three wins are
  local-path *sharp edges*, and none of them blocks real work: the peer-major coupling that
  broke v0.3.1 out of the box is already fixed by moving the peer set forward together
  (Session 0 R1), the cold-load timeout is handled by the retained pre-warm (which doesn't
  interact with the s2 sandbox — the model client stays host-side under shape B), and `num_ctx`
  is a UX wart, not a blocker. So deferring native costs nothing on the "working, doing real
  work" axis.

  The *stronger* reason is the shape of the v3 deliverable itself: it is a **comparison
  experiment** ("where did the local model get stuck — the model or the transport?"). That
  wants a stable, well-understood baseline transport, which is exactly what proven ai_sdk is —
  and on ai_sdk the local **critic keeps Ollama's constrained decode** for its JSON verdict,
  whereas native moves it to prompt+parse+repair, a plausible reliability *regression* for a
  weak local model. Flipping the transport before measuring anything would both change the
  variable under test and risk a worse critic right when we want stability. Staying on ai_sdk
  keeps native as a clean *second* variable: flip it later and re-measure to isolate whether
  the transport itself mattered. Better science and less risk, pointing the same way.

  **The one native investment to make now:** prove the bridge is real *once* — during the
  Session 0 live run, flip to `transport: 'native'`, confirm the loop runs, flip back (already
  in the verification plan). That turns "it's a one-line change" from a claim into a tested
  fact, so the option stays genuinely cheap to exercise later without spending it now.

---

## Verification plan (end-to-end, not just unit tests)

Ollama is running locally; use it. Gate live work behind `VOLLEY_LIVE` as today.

1. **Session 0 acceptance.** With `ai@^7` + `ai-sdk-ollama@^4` installed: `pnpm check` green on
   fascicle 0.9.5; run the `VOLLEY_LIVE` local-builder smoke test on the ai_sdk transport and
   confirm it passes (the v0.3.1 peer-major mismatch is gone now that fascicle wants `ai@^7`).
   Point it at a **cold large model** and confirm the retained pre-warm keeps it from timing
   out. Run the all-Claude live smoke (builder + critic schema) and confirm the 0.9.5
   `claude_cli` schema path works. Sanity-check that a one-line `transport: 'native'` edit in
   `engine.ts` also runs (proving the bridge is ready), then revert it.
2. **Phase 2a.** A local build writes into a worktree branch; `git -C <worktree>` shows the
   diff; abandoning the phase discards the branch; a dirty worktree rotates + logs.
3. **Phase 2b.** `bash -c 'cat /etc/passwd'` inside the sandbox cannot read the host file;
   `--dry-run` with Docker stopped exits 5 before any model spend; `--allow-unsandboxed-builder`
   still runs (with the loud warning) and skips Docker.
4. **Phase 2c.** Run **both** blessed examples on the same task/criteria/caps; confirm
   `.volley/summary.json` carries the comparison fields for each, and write up the finding
   (where the local model got stuck; model vs transport), confounds disclosed.

Ship each session behind its own `pnpm check` gate. **Merge `local-builder` → `main` right
after Session 0** (decided): Session 0 lands the fascicle 0.9.5 upgrade and carries the v0.3.1
fixes that removed the last out-of-box breakage, so `main` should hold that known-good state
before the larger s2 containment work begins on top of it.
