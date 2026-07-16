<!--
build-log.md — your live ledger for execution. Append constantly; reorganize at
step boundaries. The antidote to "my plan got lost in the noise."

  Steps     : where you are. One step in flight at a time.
  Park list : where ideas go so you do not chase them. CAPTURE, never act inline.
  Harvest   : the boundary ritual that keeps you on one branch.
  Log       : the build's history. `plumbbob checkpoint` appends a line per step as it
              lands; feeds the /pb-finish report, which rides the branch into the PR.
-->

# Build log — volley v3 finish — fascicle 0.9.5 + sandbox/worktree

**Current step:** none (at the boundary)
**Heavy check:** checkride (set a "check" key in .plumbbob/settings.json to override)

## Steps

*(Mirror of intent.md's Steps, with live status. Only ONE step is in flight. A step
is done only after a checkpoint — check green + checkpoint taken, via `/pb-verify` or
`/pb-build`.)*

- ☐ 1. <step>

## Park list

> Mid-step, every new problem / idea / "ooh what if" lands HERE, untouched, and you
> go straight back to the step. Acting the instant an idea arrives is the disease.
> Capture is one line (`/pb-park` composes it). Harvest happens only at the boundary.

## Harvest  *(run `/pb-harvest` at each step boundary, after green)*

Classify each parked item as exactly ONE. Naming it before acting is what keeps you
from sprawling across branches.

| Class            | Meaning                                   | Action                          |
|------------------|-------------------------------------------|---------------------------------|
| **blocker**      | Plan was wrong/incomplete; can't proceed  | `/pb-revert`, fold into intent  |
| **tangent**      | A different path, not clearly better      | Defer or kill. Default here.    |
| **pivot signal** | Evidence the whole approach is wrong      | Stop. Replan deliberately.      |

> Reality check: almost everything that *feels* like a pivot is a tangent. Require a
> failed assumption, not a shinier idea, before you pivot.

Harvest results this boundary:

- (none yet)

## Log

*(The build's history, oldest first. `plumbbob checkpoint` appends a dated line here
every time a step lands — via `/pb-build` or `/pb-verify` — so this
fills in as you go, not at the end. Add your own decision/event lines too: this is what
you point at to say "I did that — the LLM helped, but those were my calls."
`/pb-finish` reads this for the report; `plumbbob finish` commits it with the build
folder, so it rides the branch into the PR.)*
- 2026-07-14 — step 1 checkpointed · b6a4f3c99 — Bump the peer set forward together + update docs (R1) (1 drift, 7m)
- 2026-07-14 — step 2 checkpointed · 809d04216 — Keep ai_sdk transport; document the native flip as the future bridge (R2) (5m)
- 2026-07-14 — step 3 checkpointed · 02637634a — Retain the v0.3.1 workarounds; annotate reduced necessity under native (R3) (8m)
- 2026-07-14 — step 4 checkpointed · 22c43e82c — Verify both critic-schema paths (R4 + R5) (21m)
- 2026-07-14 — step 5 checkpointed · c4e23aa62 — Session 0 live acceptance + prove the native bridge once (verification §1) (61m)
- 2026-07-14 — step 6 checkpointed · 90bf25f75 — Merge Session 0 to `main` (D4) (2m)
- 2026-07-14 — step 7 checkpointed · c2fa9fa22 — Worktree orchestration module (1 drift, 6m)
- 2026-07-14 — step 8 checkpointed · 627d6422c — Re-point `contain()` root to the worktree + `--worktree` flag/config (s2 D3) (1 drift, 32m)
- 2026-07-14 — step 9 checkpointed · b21f69223 — Worktree-branch checkpoints (extends `--git`; D13) (1 drift, 16m)
- 2026-07-14 — step 10 checkpointed · 5f0727db9 — `Dockerfile` + default image (s2 D5; D11) (1 drift, 16m)
- 2026-07-14 — step 11 checkpointed · 5895dc7ba — Swap the `bash` executor `spawnSync` → `docker exec` (s2 D1/D3; D9, D11) (1 drift, 176m)
