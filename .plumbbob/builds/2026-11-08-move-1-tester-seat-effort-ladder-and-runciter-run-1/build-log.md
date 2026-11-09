<!--
build-log.md: your live ledger for execution. Append constantly; reorganize at
step boundaries. The antidote to "my plan got lost in the noise."

  Steps     : where you are. One step in flight at a time. CLI-maintained: `build`,
              `checkpoint`, and `revert` keep this mirror and the Current step line
              in sync with intent.md; you never hand-edit them.
  Park list : where ideas go so you do not chase them. CAPTURE, never act inline.
  Harvest   : the boundary ritual that keeps you on one branch.
  Log       : the build's history. `plumbbob checkpoint` appends a line per step as it
              lands; feeds the /plumbbob:finish report, which rides the branch into the PR.
-->

# Build log: move 1: tester seat, effort ladder, and runciter.run/1

**Current step:** 3 — feat(summary): record each iteration's rung and why it climbed
**Heavy check:** checkride (set a "check" key in .plumbbob/settings.json to override)

## Steps

*(Mirror of intent.md's Steps, with live status; CLI-maintained, not hand-edited.
`build`/`checkpoint`/`revert` re-render this from intent.md, and set the Current step
line above. Only ONE step is in flight; a step is done only after a checkpoint:
check green + checkpoint taken, via `/plumbbob:verify` or `/plumbbob:build`.)*

- ☑ 1. feat(config): parse the effort ladder and the critic's effort
- ☑ 2. feat(loop): run the builder at the iteration's rung and the critic at its effort
- ☐ 3. feat(summary): record each iteration's rung and why it climbed
- ☐ 4. docs(readme): the effort ladder
- ☐ 5. feat(tester): the tester seat's config, prompt and tools
- ☐ 6. feat(flow): the test phase before the first build, red check required
- ☐ 7. feat(critic): the critic reads the tester's test
- ☐ 8. feat(acp): the tester under `volley acp`, and its docs
- ☐ 9. feat(protocol): the runciter.run/1 schemas and the input mapping
- ☐ 10. feat(cli): `volley run --protocol runciter.run/1`
- ☐ 11. docs(protocol): the protocol mode and its conformance fixture

## Park list

> Mid-step, every new problem / idea / "ooh what if" lands HERE, untouched, and you
> go straight back to the step. Acting the instant an idea arrives is the disease.
> Capture is one line (`/plumbbob:park` composes it). Harvest happens only at the boundary.

- [ ] effort_ladder and critic_effort aren't written to config.json (workspace.ts) or read back by load_resume_state (iteration.ts), so a resumed run loses its ladder unless VOLLEY_EFFORT_LADDER is set; step 2's resume work needs both, and its seam lacks workspace.ts

## Harvest  *(run `/plumbbob:harvest` at each step boundary, after green)*

Classify each parked item as exactly ONE. Naming it before acting is what keeps you
from sprawling across branches.

| Class            | Meaning                                   | Action                               |
| ---------------- | ----------------------------------------- | ------------------------------------ |
| **blocker**      | Plan was wrong/incomplete; can't proceed  | `/plumbbob:revert`, fold into intent |
| **tangent**      | A different path, not clearly better      | Defer or kill. Default here.         |
| **pivot signal** | Evidence the whole approach is wrong      | Stop. Replan deliberately.           |

> Reality check: almost everything that *feels* like a pivot is a tangent. Require a
> failed assumption, not a shinier idea, before you pivot.

Harvest results this boundary:

- (none yet)

## Log

*(The build's history, oldest first. `plumbbob checkpoint` appends an entry here
every time a step lands (via `/plumbbob:build` or `/plumbbob:verify`): the dated line,
and beneath it the pause as you approved it, so this fills in as you go, not at the
end, and an older step's detail is a scroll away. Add your own decision/event lines too: this is what
you point at to say "I did that: the LLM helped, but those were my calls."
`/plumbbob:finish` reads this for the report; `plumbbob finish` commits it with the build
folder, so it rides the branch into the PR.)*

- 2026-11-09 — step 1 checkpointed · 67bd55109 — feat(config): parse the effort ladder and the critic's effort (1 drift, 6m)

  **Readout**:

  ```text
  check        green: 1 of 1 checks
  seam         strayed: 5 paths outside the seam
               - test/helpers/harness.ts
               - test/integration/cli.test.ts
               - research/capability-vs-enforcement.md
               - research/effort-ladder-and-ensemble.md
               - research/specialist-seats-and-equilibrium.md
  diff         +790 -4 across 9 files
               - research/capability-vs-enforcement.md +122 -0
               - research/effort-ladder-and-ensemble.md +90 -0
               - research/specialist-seats-and-equilibrium.md +154 -0
               - src/cli.ts +32 -3
               - src/config.ts +96 -0
               - src/types.ts +20 -1
               - test/helpers/harness.ts +2 -0
               - and 2 more
  spent        6 min · 18s gate · green first run
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Approve it. The read checked the seams against `src/` as it stands (the phase tree in `flow.ts`, the single baseline in `changes.ts`, the exit table in `exit_codes.ts`, the `--json` path in `cli.ts`) and the protocol against runciter's §5.4, and found the steps buildable in order with the three holes above, each already carried as a lean (Q1–Q4) rather than a guess; `yes to all leans` settles them in one reply, and range 1's stop is where the one real unknown, Q4, is read off a live run.

  **1.** The claude_cli arm may ignore `effort`, which would make the ladder flat where it matters most (Q4, step 2)

  fascicle resolves `effort` per call and asks the adapter to translate it (`src/engine/generate.ts`, `translate_effort`, `record_effort_ignored`). I did not find the claude_cli transport's translation in this read, so whether a Claude seat honours a rung is unknown until step 2 runs. Q4's lean names the fallback (`--effort <rung>` through `provider_options.claude_cli.extra_args`, only when a ladder is set, so C4's default arm stays byte-identical). Closing it is step 2's first hour; range 1's stop is where the human reads the rung lines on a real run and confirms it.

  **2.** Change attribution with a tester in the loop (D9, step 6)

  Today every iteration's change set is measured against the run's one `baseline` (`PhaseDeps.baseline`, `src/changes.ts`), and any edit under `gate_paths` is a builder gate edit. With the tester writing under the gate paths first, the same measurement would flag the tester's test as a builder gate edit in this iteration and every later one. D9 says what to do (record `tester_changes`, checkpoint after the tester, exclude tester-written paths from `gate_edits` unless the builder changed them further), and step 6's seam names `src/changes.ts`, but the builder would have to pick the comparison point: the lean is the tester's post-write checkpoint when checkpoints are on, and a recorded list of tester paths when they are off.

  **3.** The protocol's exit table and C6 (Q2, steps 10–11)

  C6 says each exit code keeps the meaning the README's table gives it, and its held-by test maps run statuses to exit codes. Protocol mode needs 0/1/2 with runciter's meanings, where 2 is budget exhausted on the plain CLI. D11 keeps the tables apart and Q2 asks the human whether that reading of C6 is theirs. It costs nothing to settle now and would cost a reworked step 10 later.

- 2026-11-09 — step 2 checkpointed · da206c503 — feat(loop): run the builder at the iteration's rung and the critic at its effort (1 drift, 6m)
