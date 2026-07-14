# volley v3 finish — fascicle 0.9.5 + sandbox/worktree

**Phase** (your own bookkeeping while framing): frame
**Size:** medium (multi-session finish: Session 0 upgrade → Session 2 containment + examples)

*Source: research/specs/volley-spec-v3-reconciled.md (this intent distills it; the full spec, s2 sub-spec, and v2 spec ride the branch alongside it).*

## Frame

- **Problem:** volley shipped the local-builder tool loop as **v0.3.1** (Session 1, merged
  and live-tested), but "v3 done" needs three things reconciled onto one path. (1) The
  user upgraded the **fascicle** source `0.8.16 → 0.9.5`, which lands breaking AI SDK v7
  peers + a native transport option; volley's `node_modules` still pins `0.8.16`, so
  consuming `0.9.5` is itself part of finishing. (2) Session 2 — Docker sandbox + git
  worktree containment for the local builder — is unbuilt. (3) The two blessed comparison
  examples that *prove* v3 (all-Claude vs all-local) don't exist yet.
- **Smallest thing that solves it:** **Session 0 first** — consume fascicle 0.9.5 on the
  **existing `ai_sdk` transport** by moving the whole peer set (`ai`, `ai-sdk-ollama`)
  forward to its v7 line, retaining the v0.3.1 fixes; merge to `main`. **Then Session 2**
  in three shippable phases — 2a git worktree (isolate *effects*), 2b Docker sandbox
  (isolate *blast radius*, shape B), 2c preflight + the two examples.
- **Done looks like:** `pnpm check` green on fascicle 0.9.5 with `ai@^7` + `ai-sdk-ollama@^4`;
  the `VOLLEY_LIVE` local-builder smoke passes on ai_sdk (peer-major mismatch gone); a cold
  large model still succeeds via the retained pre-warm; the all-Claude live path (builder +
  critic schema, now unblocked by the 0.9.5 fix) passes; a local build writes into a Docker
  sandbox over a git worktree; and **both** blessed examples run the same task/criteria/caps,
  emitting comparison fields to `.volley/summary.json` with a written finding (model vs
  transport, confounds disclosed).
- **Explicitly NOT doing:** **migrating to the native transport** (kept as a documented,
  one-line, *proven-once-then-reverted* future option — D2); the checkride
  artifact-verification / double-run fix (s2 D8, out of scope for v3); anything requiring
  Docker on the all-Claude path; the parked native-only critic-decode question (OQ-0).

## Architecture sketch

```
Session 0 (prerequisite, on ai_sdk):   deps forward together → main
  package.json: fascicle 0.9.5, ai@^7, ai-sdk-ollama@^4  (peer-major mismatch resolved)
  engine.ts: default transport 'ai_sdk' unchanged (+ native-flip comment)
  prewarm / context_check / base-url normalizer: KEPT (load-bearing on ai_sdk)

Session 2 (containment, shape B):
  ┌ host ─────────────────────────────────────────────┐
  │ volley: Node + model client + tools               │   local provider stays trivial
  │   contain() root ── re-pointed ──► git worktree ◄──┼── bind-mount
  │   bash tool: spawnSync ──► docker exec ────────────┼──► container (node/pnpm toolchain)
  │   orchestrator: worktree create/rotate/teardown    │      default-deny egress
  └───────────────────────────────────────────────────┘
  2c: --dry-run preflight (exit 5 pre-spend) + examples/{all-claude,all-local}
```

## Decisions

- D1: **Stay on the `ai_sdk` transport**; consume 0.9.5 by moving the peer set
  (`ai@^7`, `ai-sdk-ollama@^4`) forward *together* — *because* that resolves the v0.3.1
  peer-major mismatch by construction (the v7-line `ai-sdk-ollama@^4` is exactly what
  `ai@^7` wants), and a stable, well-understood baseline transport is what the v3
  comparison experiment needs.
- D2: The **native transport is a documented, ready-to-flip future option**, proven once
  during the Session 0 live run then reverted — *because* its three wins are local-path
  sharp edges that don't block real work, and keeping it as a clean *second* variable lets
  us later isolate whether the transport itself mattered.
- D3: **Retain all three v0.3.1 workarounds** (base-URL normalizer, cold-load pre-warm,
  `num_ctx` warning); only annotate their reduced necessity under native — *because* they
  are load-bearing on the ai_sdk/undici path (the pre-warm is what keeps a cold multi-GB
  model under undici's ~300s in-request timeout). Resolves OQ-5 (keep prewarm now).
- D4: **Session 0 lands before s2, and `local-builder` merges to `main` right after
  Session 0** — *because* s2's all-local example stands on a working local transport, and
  `main` should hold the known-good (v0.3.1 fixes + 0.9.5) state before containment work.
- D5: **Sandbox shape (B)** — volley (Node, model client, tools) stays on the **host**; only
  the `bash` tool's commands run via `docker exec` against a container that bind-mounts the
  worktree — *because* it keeps native local-provider access trivial (s2 D1, author-locked lean).
- D6: **`--sandbox` default-on for a local builder**, forbidden/no-op for `claude_cli`;
  `--allow-unsandboxed-builder` becomes the **shape-C escape hatch** (still prints the loud
  warning, skips volley's Docker orchestration) — *because* containment is the correct
  blast-radius default for an untrusted local model.
- D7: **Rotate-on-conflict** for worktrees, mirroring `initialize_workspace`'s
  `.volley.bak.<ts>` rotation — *because* it's the established precedent and never destroys
  prior state.
- D8: **The two blessed examples (all-Claude, all-local) are the v3 deliverable**;
  `examples/local-critic/` stays as the mixed midpoint — *because* v3's whole point is the
  comparison experiment (s2 D10, locked). All ten s2 decisions (D1–D10) from
  `volley-spec-v3-s2-sandbox-worktree.md` carry forward verbatim.
- D9: **Sandbox container lifecycle — one long-lived container per run** (`docker run -d …
  sleep infinity`), commands via `docker exec` — *because* the web research confirms this is
  the universal production pattern (E2B, Modal, Daytona, OpenHands, SWE-agent, AutoGen, and
  **Anthropic's own bash tool** all keep one container/session per run and `exec` many
  commands; per-command `docker run` is used by no one — ~400 ms/command overhead, ~40 s over
  100 commands, for zero isolation payoff), and on Docker **≥ 19.03** `exec`'d commands inherit
  the container's cap-drop / no-new-privileges / seccomp / AppArmor / cgroup caps (moby #38871).
  **Operational riders:** (i) preflight a **Docker ≥ 19.03 check** — pre-19.03 `exec` silently
  drops no-new-privileges + caps, so hardening evaporates; (ii) run with **`--init`** (tini PID 1)
  to reap zombies; (iii) **reap stray/background processes between commands** — the one hygiene
  bit per-command `--rm` gives free (volley's bash is already stateless, so nothing of value is
  lost); (iv) volley must **never pass `--privileged` / `--user 0` on its `exec` calls**.
  *(resolves Q1 / s2 OQ-1, web-researched)*
- D10: **volley owns its containment; do not depend on `claude_cli`'s sandbox** — the
  all-Claude path stays Docker-free and volley does **not** harden the CLI builder via
  fascicle's `claude_cli` bwrap/greywall sandbox — *because* that API's stability is unknown;
  volley's own Docker sandbox is the containment story. (The s2 D9 confound therefore stays
  *disclosed*, not narrowed.) *(resolves Q3 / s2 OQ-3)*
- D11: **Container hardening defaults** *(from web research, tunable via `VOLLEY_SANDBOX_*`)* —
  run **non-root as the host UID/GID that owns the worktree**, with `--memory=4g
  --memory-swap=4g --memory-swappiness=0 --cpus=2 --pids-limit=1024 --cap-drop=ALL
  --security-opt=no-new-privileges --init`, keep default seccomp (never `--privileged`), `--ulimit
  nofile=8192:16384 --ulimit core=0`, and `--read-only` + tmpfs for `/tmp`,`/run`,`~/.cache`
  with the pnpm store on a named volume — *because* these contain a runaway / fork-bomb / OOM
  without breaking pnpm/tsc. **Footguns to honor:** `--user` MUST match the worktree owner or
  bind-mount writes get `EACCES`; `--pids-limit` 100 starves vitest/jest workers (use ~1024);
  `nofile` too low breaks esbuild/watchers; every write path must be tmpfs/volume under
  `--read-only`. *(resolves Q2 caps / s2 OQ-2)*
- D12: **Network egress default-deny + host-collapsed allowlist** — put the container on a
  user-defined bridge, **default-DROP forwarded egress in the `DOCKER-USER` chain** (allow
  ESTABLISHED/RELATED + DNS), and reach the two allowlist targets (host LLM endpoint + package
  registry) by **collapsing them onto the host** via `--add-host=host.docker.internal:host-gateway`
  (optionally a host-side registry mirror), also restricting the host `INPUT` chain to just
  those ports; a fully offline all-local run uses `--network none` after deps are warmed —
  *because* `HTTP_PROXY`/`--dns` filtering is advisory and bypassable by untrusted code, so
  egress must be enforced at L3/L4. *(resolves Q2 network / s2 OQ-2; kernel-shared caveat —
  gVisor/Kata is a future "paranoid mode", out of scope now.)*
- D13: **Worktree checkpoint semantics** — one **named branch per phase** via `git worktree
  add -b <phase-branch> <path> <base>`; each checkpoint is `git -C <path> add -A && git -C
  <path> commit --no-verify` (keeps the two-per-iteration cadence, off the shared pre-commit
  hook); **keep the raw checkpoint commits on the phase branch** as the audit/replay trail and
  **squash-merge on integration**; teardown is the idempotent trio `git worktree remove
  --force <path>` → `git branch -D <phase-branch>` → `git worktree prune` — *because* a named
  branch is a nameable/deletable ref (detached HEAD isn't), the shared object store makes the
  diff immediately visible to main, and a checked-out branch can't be deleted (remove the
  worktree first). These are plain git calls, not iteration — `orchestrator-no-loops` unaffected.
  *(resolves Q4 / s2 OQ-4)*

## Constraints

- C1: **Respect all 8 checkride ast-grep rules** — `create-engine-only-in-engine`,
  `no-class`, `no-deep-sibling-import`, `no-default-export`, `no-pricing-constants`,
  `no-this`, `orchestrator-no-loops`, `require-js-extension` (functional/procedural house
  style: no classes, no `this`, no default exports, `.js` extensions on imports).
- C2: **Any added iteration uses fascicle's `loop`** — no hand-written loops in
  `src/orchestrator.ts` (`orchestrator-no-loops`).
- C3: **Exact-pin all dependency versions** per house style (the `^`-forms in this doc name
  the resolved v7-line target; pin the exact installed version in `package.json`).
- C4: **The all-Claude path must never require Docker** — `--sandbox` is forbidden/no-op for
  `claude_cli`; preflight never exits 5 on that path.
- C5: **Stay on the `ai_sdk` transport** (D1/D2) — do not add a `transport` field or migrate
  to native beyond the once-only proof-then-revert.
- C6: **Ship each session behind its own `pnpm check` gate**; `VOLLEY_LIVE` gates live work.

## Steps

### Session 0 — fascicle 0.9.5 on the ai_sdk transport (the prerequisite)

1. [x] Bump the peer set forward together + update docs (R1) — **done when:** `pnpm check`
   is green with fascicle `0.9.5`, `ai@^7`, `ai-sdk-ollama@^4` installed (exact-pinned), and
   the README peer table + `.env.example` say `ai-sdk-ollama@^4` (was `@^3`).
   - seam: `package.json`, `pnpm-lock.yaml`, `README.md`, `.env.example`
   - model: sonnet — mechanical dep bump, fully specified by the done-when
2. [x] Keep ai_sdk transport; document the native flip as the future bridge (R2) — **done
   when:** `src/engine.ts` is unchanged except the dep bump plus a code comment recording
   that flipping to native is a one-line change (`transport: 'native'` on the
   `ollama`/`lmstudio` configs) and that `resolve_ollama_base_url` already yields the
   daemon-root URL native wants; `pnpm check` green.
   - seam: `src/engine.ts`
   - model: sonnet — comment only, no logic change
3. [ ] Retain the v0.3.1 workarounds; annotate reduced necessity under native (R3) — **done
   when:** base-URL normalizer, `num_ctx` warning, and cold-load pre-warm are behaviorally
   unchanged, and a code comment on `prewarm_ollama_model` + a README local-guide line note
   that the pre-warm's necessity drops away on the native transport (raw `fetch`, no
   in-request timeout) and that `num_ctx`/`keep_alive` would move to `provider_options.ollama`.
   - seam: `src/prewarm.ts`, `src/builder/context_check.ts`, `README.md`
   - model: sonnet — documentation notes over unchanged code
4. [ ] Verify both critic-schema paths (R4 + R5) — **done when:** the local critic keeps
   Ollama constrained decode (`verdict_schema`, unchanged), and a live assertion exercises
   the all-Claude critic `verdict_schema` compiling for `claude --json-schema` on 0.9.5
   (the `compile_schema` `$schema`/`$id` strip fix) so a future fascicle regression is caught.
   - seam: `src/critic/run.ts`, `test/integration/live_smoke.test.ts`
   - model: sonnet — verify-only assertion authoring
5. [ ] Session 0 live acceptance + prove the native bridge once (verification §1) — **done
   when:** under `VOLLEY_LIVE` the local-builder smoke passes on ai_sdk (peer mismatch gone),
   a cold large model succeeds via the retained pre-warm, the all-Claude live smoke
   (builder + critic schema) passes, and a one-line `transport: 'native'` edit in `engine.ts`
   is confirmed to run the loop and then reverted.
   - seam: `test/integration/live_smoke.test.ts`, `src/engine.ts` (temporary flip)
   - model: opus — live-run judgment, interpreting live failures
6. [ ] Merge Session 0 to `main` (D4) — **done when:** `local-builder` is merged to `main`
   with `pnpm check` green, so `main` holds the known-good (v0.3.1 fixes + 0.9.5) state
   before s2 containment work begins on top of it.
   - seam: (git only — no source change)
   - model: sonnet — mechanical merge behind a green gate

### Session 2 — Phase 2a: git worktree (isolates effects)

7. [ ] Worktree orchestration module — create / rotate / teardown (s2 D2/D4; D7, D13) — **done
   when:** unit tests cover create (`git worktree add -b`), rotate, and the idempotent teardown
   trio (`worktree remove --force` → `branch -D` → `worktree prune`, D13); a dirty-or-existing
   worktree **rotates aside + logs** (mirroring `initialize_workspace`'s `.volley.bak.<ts>`, D7);
   the module is invoked around the builder phase by the orchestrator; and any added iteration
   uses fascicle's `loop` (no hand-written loop in `src/orchestrator.ts`).
   - seam: new `src/worktree.ts` (module), `src/orchestrator.ts`, `src/workspace.ts`
   - model: opus — orchestration design under the no-loops rule
8. [ ] Re-point `contain()` root to the worktree + `--worktree` flag/config (s2 D3) — **done
   when:** the containment root becomes the worktree path (write/edit/read tools already
   resolve through `contain()`), `--worktree` + its config field persist in
   `.volley/config.json` and restore on resume (defaulting like `builder_provider`), and a
   local build writes into the worktree so `git -C <worktree>` shows the diff.
   - seam: `src/workspace_tools.ts`, `src/config.ts`, `src/cli.ts`, `src/workspace.ts`, `src/types.ts`
   - model: opus — containment re-point + config plumbing
9. [ ] Worktree-branch checkpoints (extends `--git`; D13) — **done when:** `--git` checkpoints
   are taken on the **worktree branch** via `git -C <path> add -A && commit --no-verify`
   (D13), the raw checkpoints stay on the phase branch as the audit trail with a **squash-merge
   on integration**, abandoning the phase discards the branch wholesale (the D13 teardown trio),
   the `.git` pre-check precedent still guards, and Phase 2a verification passes (build writes
   to a worktree branch; abandon discards; dirty worktree rotates + logs).
   - seam: `src/workspace.ts`, `src/iteration.ts`, `src/orchestrator.ts`
   - model: opus — checkpoint semantics decision (OQ-4)

### Session 2 — Phase 2b: Docker sandbox (isolates blast radius, shape B)

10. [ ] `Dockerfile` + default image (s2 D5; D11) — **done when:** the image carries node/pnpm
    + the workspace dev toolchain so the builder can self-run `pnpm check`/checkride, runs as a
    **non-root user** (D11), and `--sandbox-image <tag>` overrides it.
    - seam: new `Dockerfile`, `src/config.ts`, `src/cli.ts`
    - model: sonnet — Dockerfile + flag wiring, mostly mechanical
11. [ ] Swap the `bash` executor `spawnSync` → `docker exec` (s2 D1/D3; D9, D11) — **done
    when:** volley starts one long-lived hardened container per run (`docker run -d … sleep
    infinity` with the D11 flag set) and the `bash` tool `exec`s against it (D9); the swap keeps
    the **tool contract unchanged** (stateless-per-command, no cwd/env drift); file writes land
    host-side in the bind-mounted worktree so `bash` sees identical files; the executor **reaps
    stray/background processes between commands** and never passes `--privileged`/`--user 0`
    (D9); and `bash -c 'cat /etc/passwd'` inside the sandbox cannot read the host file.
    - seam: `src/builder/tools.ts`, sandbox module
    - model: opus — the load-bearing containment swap
12. [ ] Network policy: default-deny egress (s2 D6; D12) — **done when:** the container sits on
    a user-defined bridge with **`DOCKER-USER` default-DROP** egress, the two allowlist targets
    are reached via `host.docker.internal:host-gateway` (D12), a fully offline all-local run
    uses `--network none` so `fetch` degrades cleanly (returns an error tool result, run
    continues), and the tool-level SSRF deny-list + container policy stack as defense in depth.
    - seam: sandbox module, `src/builder/tools.ts`
    - model: opus — network policy design
13. [ ] `--sandbox` flag + reframe the safety gate (s2 D1; D10) — **done when:** `--sandbox` is
    default-on for a local builder and forbidden/no-op for `claude_cli` (which never requires
    Docker and is **not** hardened via fascicle's `claude_cli` sandbox, D10); the gate at
    `src/config.ts:230-237` flips from "refuse a local builder" to "refuse **only when neither
    `--sandbox` nor `--allow-unsandboxed-builder` is in effect**"; `--allow-unsandboxed-builder`
    runs (loud warning, skips volley's Docker orchestration); and Phase 2b verification passes.
    - seam: `src/config.ts`, `src/cli.ts`
    - model: opus — subtle safety-gate reframe

### Session 2 — Phase 2c: preflight + the two blessed examples

14. [ ] `--dry-run` preflight, mirroring `checkride doctor` (s2 D7; D9) — **done when:** before
    any model spend it checks docker available **and ≥ 19.03** (D9 — older `exec` silently drops
    hardening), image present (build/pull per policy), worktree creatable, and local endpoint
    reachable; Docker unavailable / too old / image missing → **exit 5**, and it **never exits 5
    on the all-Claude path**.
    - seam: `src/cli.ts`, `src/config.ts`, new preflight module
    - model: opus — preflight orchestration + exit-code contract
15. [ ] The two blessed examples + `summary.json` comparison fields (s2 D9/D10) — **done
    when:** `examples/all-claude/` (`claude_cli` builder+critic, no Docker) and
    `examples/all-local/` (`ollama` builder+critic, ai_sdk transport, checkride gate, Docker
    sandbox + worktree, `fetch` enabled, targeting $0/offline) both exist and run the **same
    phase-sized task, same criteria, same checkride gate, same caps**; `examples/local-critic/`
    stays as the mixed midpoint; and `.volley/summary.json` carries iterations-to-converge,
    wall-clock, cost, verdict, check trajectory, local salvage rate, and transport used.
    - seam: new `examples/all-claude/`, new `examples/all-local/`, summary writer (`src/summary.ts`)
    - model: opus — example design + summary schema
16. [ ] Run both examples + write up the finding (verification §4) — **done when:** both
    examples run to completion, and a written finding records **where the local model got
    stuck and whether it was the model or the transport**, disclosing the confounds honestly
    (containment mechanisms differ: fascicle `claude_cli` bwrap/greywall vs volley Docker;
    tool surfaces differ; `fetch` ≠ `WebFetch`; both run ai_sdk so the AI-SDK layer is a
    shared, not differential, factor).
    - seam: `examples/all-claude/README.md`, `examples/all-local/README.md`, a finding write-up under `research/`
    - model: fable — comparison analysis + honest write-up

## Open questions

*(Q1–Q4 resolved 2026-07-13 → see Decisions D9–D13 and Verdicts. Only the two native-only
questions remain parked — neither blocks planning or this cycle.)*

- Q5 (s2 OQ-0, native-only): local critic verdict via prompt+parse+repair
  (`schema_repair_attempts`) vs Ollama constrained decode via `provider_options.ollama.format`
  — moot while on ai_sdk (constrained decode is the default; user: "stick with ai-sdk for
  now"). *resolve by:* decide (only if native is ever adopted).
- Q6 (s2 OQ-6): The bridge trigger for flipping to `transport: 'native'` (drop the
  `ai-sdk-ollama` peer, per-call `num_ctx`/`keep_alive`, no cold-load timeout — against the
  cost of moving the local critic off constrained decode). **Not worth spending on this build**
  — the one native investment worth making is already step 5 (prove the bridge runs once, then
  revert); the actual flip stays deferred. *resolve by:* decide — not this cycle.

## Verdicts

*(Filled in as spikes and forks resolve — the audit trail of "these were my calls.")*

- 2026-07-13 — transport for the finish → chose **stay on ai_sdk, move peers forward
  together**, native kept as a proven-once/reverted option; because it resolves the v0.3.1
  peer mismatch by construction and gives the comparison experiment a stable baseline. (D1/D2)
- 2026-07-13 — `src/prewarm.ts` fate (s2 OQ-5) → chose **keep** while on ai_sdk (prevents the
  cold-load timeout); revisit only under a native flip. (D3)
- 2026-07-13 — container lifecycle (Q1/s2 OQ-1, **web-researched, A-vs-B weighed**) → chose
  **one long-lived container + `docker exec`** — the universal agent-sandbox pattern (E2B,
  Modal, Daytona, OpenHands, SWE-agent, Anthropic's bash tool); per-command `docker run` costs
  ~400 ms/command for zero isolation gain, and Docker ≥ 19.03 makes `exec` inherit the
  container's hardening. Riders: preflight Docker ≥ 19.03, `--init`, reap between commands,
  never `--privileged`/`--user 0` on exec. (D9)
- 2026-07-13 — CLI-builder hardening (Q3/s2 OQ-3) → chose **volley owns its sandbox; do not
  depend on `claude_cli`'s sandbox** (its API stability is unknown); s2 D9 confound stays
  disclosed. (D10)
- 2026-07-13 — sandbox resource caps (Q2/s2 OQ-2, web-researched) → chose the D11 default flag
  set (non-root as worktree owner, 4g mem/2 cpu/1024 pids, cap-drop-all, no-new-privileges,
  read-only+tmpfs), tunable via `VOLLEY_SANDBOX_*`. (D11)
- 2026-07-13 — network egress (Q2/s2 OQ-2, web-researched) → chose **`DOCKER-USER`
  default-DROP + host-collapsed allowlist via `host-gateway`**, `--network none` when offline;
  proxy/DNS filtering rejected as bypassable. (D12)
- 2026-07-13 — worktree checkpoint semantics (Q4/s2 OQ-4, web-researched) → chose **named
  branch per phase**, `commit --no-verify` checkpoints kept as audit trail, **squash-merge on
  integration**, idempotent `remove --force → branch -D → prune` teardown. (D13)
- 2026-07-13 — native bridge trigger (Q6/s2 OQ-6) → **not this build**; prove the bridge once
  (step 5) and defer the flip. Reaffirmed ai_sdk for the local critic (Q5). (D1/D2)

## Source

Full spec: `research/specs/volley-spec-v3-reconciled.md` (supersedes the *scheduling* of
s1/s2 by inserting Session 0 ahead of s2, but preserves every locked s2 decision and the
v0.3.1 fixes). Companion specs on the branch: `volley-spec-v3-s2-sandbox-worktree.md` (the ten
s2 decisions D1–D10), `volley-spec-v2.md`, and the s1 spec. Two exact-detail reference
artifacts are preserved verbatim below so this intent stands on its own for building.

### fascicle 0.9.5 delta (verified against `~/Projects/fascicle/code/fascicle` @ 0.9.5)

| Change (fascicle version) | Evidence | Consequence for volley |
|---|---|---|
| **Native Ollama transport** on `/api/chat` (0.9.2) | `src/engine/providers/ollama_native.ts` — `base_url` is the daemon root, adapter appends `/api/chat` (L528, L536); zero `ai`/`@ai-sdk/*` in the module graph. | **Future option, not adopted now.** volley's v0.3.1 base-URL fix (server root) is already correct for native, so flipping later needs no re-pointing. |
| **Transport selector** `transport?: 'ai_sdk' \| 'native'`, **defaults to `'ai_sdk'`** (0.9.2) | `src/engine/providers/types.ts:36-48`; `ProviderConfigMap.ollama: { base_url; transport? }` at `src/engine/types.ts:319`. | The default (`ai_sdk`) is what volley wants — **no `transport` field needed**. One-line flip to `'native'` is the R2 future bridge. |
| **AI SDK v7 peers** (0.9.0), provider SDKs **optional** | fascicle `package.json`: `ai: ^7.0.0` (required), `ai-sdk-ollama: ^4.0.0` + `@ai-sdk/openai-compatible: ^3.0.0` (both optional). | volley bumps `ai` `6.0.219 → ^7` **and** `ai-sdk-ollama` `3.8.8 → ^4`. Moving all three forward together resolves the v0.3.1 mismatch. |
| **`provider_options.ollama` raw passthrough** — `options` (incl. `num_ctx`), `keep_alive`, `format`, `think` (0.9.2) | `ollama_native.ts:140-151`. | A **native-path** capability (per-call `num_ctx`/`keep_alive`). ai_sdk path keeps the existing `num_ctx` warning. |
| **`turn_timeout_ms`** per-turn budget, **default unbounded** (0.9.2) | `src/engine/types.ts:257-264`; native `invoke_turn` uses bare `fetch(..., { signal: req.abort })`, no default body timeout (`ollama_native.ts:533-546`). | Explains the v0.3.1 cold-load death (`stream interrupted: fetch failed` ~300s) as an **ai-sdk/undici default** — why the pre-warm stays (R3). |
| **`prepare_step` hook** — per-turn message reshaping (0.9.2) | `src/engine/types.ts:222-244, 286-294`. | Optional windowing lever for long loops on small-context models. Not required for v3. |
| **`subprocess` → `external` provider rename** (0.9.2, breaking) | CHANGELOG v0.9.2. | **No volley impact** — volley uses the separate `claude_cli` provider. |
| **`claude_cli` structured-output fix** (0.9.5) | `compile_schema` strips top-level `$schema`/`$id` that zod v4 stamps, which `claude --json-schema` rejects — `src/engine/providers/claude_cli/adapter.ts:152-157`. | volley's **critic schema on the `claude_cli` path now works end-to-end** on 0.9.5. Verify-only (R5). |
| **`custom_providers` open registry** (0.9.2) | `ProviderConfigMap` / `EngineConfig`. | Not needed by volley; noted for completeness. |

### Seams (files this finish touches)

- `package.json` + `pnpm-lock.yaml` — fascicle 0.9.5, `ai@^7`, `ai-sdk-ollama@^4` (Session 0).
- `src/engine.ts` — dependency bump only + a native-flip comment; `resolve_ollama_base_url` unchanged.
- `src/prewarm.ts` / `src/builder/context_check.ts` — kept; add the reduced-necessity note.
- `src/builder/tools.ts` — `bash` executor `spawnSync` → `docker exec` (2b); `contain()` root → worktree (2a, via read/write tools).
- New sandbox/worktree orchestration module(s) — create/rotate worktree, build/pull/start container, tear down; invoked around the builder phase by `src/orchestrator.ts` (respecting `orchestrator-no-loops`).
- `src/config.ts` / `src/cli.ts` — `--sandbox`, `--sandbox-image`, `--worktree`, `VOLLEY_SANDBOX_*`; reframe the `--allow-unsandboxed-builder` gate.
- `src/workspace.ts` / `src/iteration.ts` / `src/types.ts` — persist + restore the new fields; worktree-branch checkpoints.
- `Dockerfile` (new) + `examples/all-local/`, `examples/all-claude/` (new).
- `checkride.config.json` / `rules/` — respect all 8 ast-grep rules.

Shipped s1 seams the later sessions build on: the stateless `bash` tool (`spawnSync`,
`src/builder/tools.ts:463-504`), `contain()` (`src/workspace_tools.ts:35-43`),
`builder_tools()`, and the `--allow-unsandboxed-builder` refusal (`src/config.ts:230-237`).
