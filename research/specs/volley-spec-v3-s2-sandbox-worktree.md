# volley v3 — Session 2: Docker sandbox + git worktree isolation

A plan-ready specification for the second of two v3 build sessions. This session
gives the local builder its containment boundary — a **git worktree** (isolates
*effects*) mounted into a **Docker sandbox** (isolates *blast radius*) — and
delivers the two blessed comparison examples that prove v3.

**Prerequisite: Session 1 has landed** — the local builder tool loop
([volley-spec-v3-s1-local-builder.md](./volley-spec-v3-s1-local-builder.md)) is
merged and runnable (unsandboxed, behind `--allow-unsandboxed-builder`). This
session turns that opt-out from the *only* way to run a local builder into the
*escape hatch*, and makes the sandbox the default path.

Everything true in [volley-spec-v2.md](./volley-spec-v2.md) carries forward;
this document supersedes the containment portions of the v3 refinement draft
([volley-spec-v3.md](./volley-spec-v3.md)).

---

## Frame

**Problem.** Session 1 hands a local model a real `bash` tool that runs
unsandboxed on the host. Any path-scoping in a tool's `execute` (the `contain()`
guard) is trivially bypassed by `bash -c 'cat /etc/passwd'`, so for the local
builder **the container and the worktree are the containment boundary, not the
tool schemas**. Without it, a runaway or adversarial command can touch the host
filesystem, exfiltrate over the network, or exhaust host resources — and the
builder's effects are entangled with the working tree instead of being a
disposable branch.

**Smallest thing that solves it.** Two composed isolation layers under shape
(B) (Decision 1): (a) a git **worktree** per run — the builder's writes are a
branch that can be diffed, checkpointed, and discarded wholesale; (b) a Docker
**sandbox** that bind-mounts that worktree and executes the `bash` tool via
`docker exec`. Session 1 made `bash` stateless per command precisely so this is
a `subprocess.run` → `docker exec` swap with no tool-contract change.

**Done when.** The all-local example runs fully contained — the builder's
`bash` cannot escape the container, its writes land in a worktree branch, and a
`--dry-run` preflight catches a missing Docker / image / local endpoint before
any model spend. Both blessed comparison examples (all-local and all-Claude) run
the *same* phase-sized task with the *same* criteria, checkride gate, and caps,
and record the comparison data in `.volley/summary.json`. The sandbox is the
default for a local builder; `--allow-unsandboxed-builder` remains as the
shape-C escape hatch.

**Explicitly not doing (this session).**

- No change to the builder tool *contracts* or transport — those are Session 1
  and are reused verbatim. This session changes only *where* `bash` and the file
  writes execute.
- No `web_search` (deferred from v3 entirely — Session 1 Decision 8).
- No artifact-verification fix for the checkride double-run — documented as a
  known all-local cost for v3 (Decision 8 below).

---

## Decisions & constraints

1. **Shape (B): harness on host, `bash` execs into the container.** `[author-
   locked lean, confirmed]` volley (Node process, model client, tools) runs on
   the **host** — keeping local-provider (ollama/lmstudio) access trivial — and
   only the `bash` tool's commands run via `docker exec` against a container
   that bind-mounts the worktree. Rejected alternatives: (A) container-wraps-the-
   whole-harness (strongest isolation but the container must reach the local
   model endpoint and carry checkride's toolchain, and it fights the "run
   repeatedly to compare" low-friction workflow); (C) user-provided devcontainer
   (weakest guarantee, but it is a real mode — it becomes the
   `--allow-unsandboxed-builder` escape hatch from Session 1, not a separate
   orchestration path). The research brief is explicit that Session 1's stateless
   `subprocess.run` bash "literally just switch[es] out `subprocess.run` with
   `docker exec`" — shape (B) done statelessly, no cwd/env drift to reconcile.

2. **Two layers, two jobs.** `[locked]` The **git worktree** isolates *effects*:
   a phase = a worktree = a branch (the natural home for the "one volley per
   phase" model), diffable, checkpointable (extends v2 `--git`), discardable. The
   **Docker sandbox** isolates *blast radius*: the `bash` tool runs in a
   container with the worktree mounted, so network policy, CPU/memory limits, and
   writable mounts are container config. They compose — the worktree is what the
   container mounts.

3. **File tools and `bash` act on the same bind-mounted worktree.** Under shape
   (B), `write_file`/`edit_file` write to the **host-side worktree path**; the
   container bind-mounts that exact directory, so `bash` (via `docker exec`) sees
   the identical files. Because `bash` is stateless per command, there is no
   divergence between the host-FS write path and the container-FS exec path —
   they are one directory. (This resolves the v3 draft's §12 Q2.)

4. **Worktree conflict policy: rotate.** On an existing/dirty worktree, rotate it
   aside and create a fresh one (mirror v2's `.volley.bak` rotation), rather than
   refusing or silently reusing. Interacts with the existing `--git` checkpoints:
   the worktree branch is where checkpoints are taken.

5. **volley ships a Dockerfile and default image; the tag is overridable.**
   The container image must contain node/pnpm and the workspace's dev toolchain
   (so the builder can run `pnpm check` / checkride itself — v2 §9 `[locked]`).
   volley ships a `Dockerfile`, builds/pulls a default image on preflight, and
   accepts a `--sandbox-image <tag>` override for a user-provided image. The
   all-Claude path must **not** require Docker.

6. **Network policy: default-deny egress except what the run needs.** The
   container denies egress by default, allowing only the model endpoint (for the
   in-container case, N/A under shape B since the model client is host-side) and
   any hosts `fetch` is permitted to reach. A fully-offline all-local run
   disables `fetch` cleanly (Session 1's `fetch` already degrades to a returned
   error). The tool-level SSRF deny-list (Session 1) and the container network
   policy are defense in depth.

7. **`--dry-run` preflight mirrors `checkride doctor`.** Before any model spend,
   check: `docker` available, the image present (build/pull if the policy says
   so), the worktree creatable, and the local endpoint reachable. Docker
   unavailable or image missing → config/preflight error, **exit 5**. Never on
   the all-Claude path.

8. **The checkride double-run stays, documented as a known all-local cost.**
   v2 §13.2's open question (builder self-runs `pnpm check`, then the gate runs
   it again) is *worse* on slow local hardware inside a container, but the
   artifact-verification fix (trust a fresh `.check/summary.json` instead of
   recomputing) is out of scope for v3. Document the double run as a measured
   cost of the all-local path; revisit later.

9. **Containment mechanisms differ across the two blessed configs — name it.**
   A hardened all-Claude run reaches containment through fascicle's `claude_cli`
   `sandbox` config (bwrap/greywall, network allowlist, extra write paths — v2
   §13.4); a hardened all-local run reaches it through volley's Docker boundary.
   These are two different mechanisms, which is a **confound** for the §8 "fair
   comparison" and must be disclosed there, not hidden. Whether `--sandbox` for a
   local builder should also map onto fascicle's `sandbox` for the CLI builder is
   left open (Open Question 3).

10. **The two blessed comparison examples are the v3 deliverable.** `[locked]`
    A real, working **all-local** example and a real **all-Claude** example,
    built to be compared — same for the critic (all-Claude critic vs all-local
    critic). This is what proves v3.

---

## Isolation design

### Git worktree — isolates effects

Each run operates in a dedicated worktree of the target repo (a phase = a
worktree = a branch). The builder's writes are a branch that can be diffed,
checkpointed per phase (extends v2 `--git`), and discarded wholesale if the
phase is abandoned. Session 1's `write_file`/`edit_file` are re-pointed from the
workspace root to the worktree path; because they already go through
`contain()`, the containment root simply becomes the worktree.

### Docker sandbox (shape B) — isolates blast radius

The `bash` tool's executor changes from a host `subprocess.run`-equivalent
(Session 1) to `docker exec` (or exec against one long-lived `docker run`
container per run — Open Question 1) against a container that bind-mounts the
worktree. Stateless per command means no cwd/env drift. Container config carries
network policy (Decision 6), CPU/memory limits, and the worktree mount. The
model client and Node stay on the host, so ollama/lmstudio access is unchanged
from Session 1.

### Container image

Ship a `Dockerfile` producing an image with node/pnpm and the workspace dev
tools so the builder can self-run `pnpm check`. Preflight builds or pulls the
default image; `--sandbox-image` overrides it. (Decision 5.)

---

## Config and CLI surface

| Flag / env | Governs | Notes |
|---|---|---|
| `--sandbox` (+ image/limits/network config) | Docker containment (Decision 1–6). | Default-on for a local builder; forbidden / no-op for `claude_cli`. |
| `--sandbox-image <tag>` | Override the default container image (Decision 5). | Falls back to the shipped default. |
| `--worktree` (+ config) | Git worktree isolation (Decision 2, 4). | Interacts with existing `--git` checkpoints. |
| `--allow-unsandboxed-builder` / `VOLLEY_ALLOW_UNSANDBOXED_BUILDER` | (From Session 1.) Now the shape-C escape hatch: "I already run inside a devcontainer." | Prints the loud warning; skips volley's own Docker orchestration. |
| `VOLLEY_SANDBOX_*` (network / limits) | Container network + resource policy. | Defaults keep an all-local run offline-capable. |

Persist the new sandbox/worktree fields in `.volley/config.json` and restore
them on resume, defaulting like `builder_provider` does.

---

## The two comparison configurations (§8)

- **all-Claude** — `builder_provider: claude_cli`, `critic_provider: claude_cli`
  (today's default). The frontier baseline.
- **all-local** — `builder_provider: ollama` (a pinned tool-capable build,
  e.g. a Qwen3 ≥ 8B whose dialect matches the runtime parser),
  `critic_provider: ollama`, `check: checkride`, Docker sandbox + worktree,
  `fetch` enabled. Targets $0, offline.
- The existing `examples/local-critic/` (Claude builder + local critic) remains
  as the mixed midpoint.

Both examples run the **same phase-sized task** with the **same criteria and the
same checkride gate**, so the only intended variable is the provider.

**What "fair" means, precisely.**

- **Controlled:** same task, criteria, `check`, `max_iterations`, `max_cost_usd`.
  Only the provider differs.
- **Measured** (mostly already in `.volley/summary.json`): iterations to converge
  (or non-convergence), wall-clock, cost (all-local ≈ $0), final verdict, the
  check pass/fail trajectory, and — added for the local path — the per-run
  **salvage rate** and the **transport used** (Session 1 records both).
- **Confounds disclosed honestly:** the containment mechanisms differ (fascicle
  `sandbox` vs volley Docker — Decision 9); the builder tool surfaces differ (CLI
  built-ins vs volley tools); `fetch` ≠ `WebFetch`; if the local path ever falls
  back to a Tier 2 text protocol, the transport differs too. A "fair" comparison
  controls the **task**, not the machinery — the finding to record is not "who
  won" but *where the local model got stuck, and whether it was the model or the
  transport*.
- Pin the local model and the task in the example so the comparison is
  reproducible, not aspirational.

---

## Seams

- **`bash` executor** — the one function Session 1 wrote as a host
  `subprocess.run`-equivalent becomes `docker exec` against the run's container.
  Tool contract unchanged.
- **`contain()` root** — `write_file`/`edit_file`/read tools resolve against the
  worktree path instead of the raw workspace.
- **New sandbox/worktree orchestration module(s)** — create/rotate the worktree,
  build/pull/start the container, tear both down; invoked by the orchestrator
  around the builder phase.
- **Preflight** — extend the `--dry-run` path (mirror `checkride doctor`) with
  the Docker + image + endpoint checks (Decision 7).
- **`examples/`** — add `examples/all-local/` and `examples/all-claude/` (or a
  single side-by-side example dir) with pinned config and task.
- **Config plumbing** — sandbox/worktree fields through
  `types.ts`/`config.ts`/`cli.ts`/`workspace.ts`/`iteration.ts`, as in Session 1.

---

## Failure modes (extends Session 1 / v2 §9)

| Scenario | Expected behavior |
|---|---|
| Docker unavailable / image missing (local builder) | Config/preflight error → **exit 5** (mirror `checkride doctor`), before any model spend. Never on the all-Claude path. |
| Worktree already exists / dirty | Rotate aside and create fresh (Decision 4); the rotation is logged. |
| `bash` tries to escape the container / touch the host FS | Contained by the sandbox — the write lands in the container/worktree only; not a host escape. |
| `fetch`/`web-tool` blocked by sandbox network policy | Error surfaced to the model as a tool result (not swallowed); run continues. A fully-offline run disables `fetch` cleanly. |
| Container build/pull fails on preflight | Preflight error → exit 5, before model spend; message names the image and the failure. |
| checkride runs twice (self-run + gate) on slow local hardware | Accepted, known cost (Decision 8); visible in the recorded wall-clock. |

---

## Open questions (park — none blocks planning)

1. **Persistent container vs per-command `docker run`.** Both satisfy stateless
   `bash`. One long-lived `docker run` per run with `docker exec` per command is
   the likely pick for speed; leave the impl choice to planning.
2. **Exact container limits.** CPU/memory caps and the precise network allowlist
   shape — concrete values to pick, not a design question.
3. **`--sandbox` ↔ fascicle `sandbox`.** Whether a local-builder `--sandbox` run
   should also harden the CLI builder via fascicle's `sandbox` (bwrap/greywall),
   so a "hardened all-Claude" and a "hardened all-local" reach containment more
   comparably (narrowing the Decision 9 confound).
4. **Worktree ↔ `--git` checkpoint interaction.** Exact semantics of checkpoints
   taken on the worktree branch vs the existing `--git` behavior.
