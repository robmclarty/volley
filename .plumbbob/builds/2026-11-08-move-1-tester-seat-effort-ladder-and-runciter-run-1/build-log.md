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

**Current step:** 6 — feat(flow): the test phase before the first build, red check required
**Heavy check:** checkride (set a "check" key in .plumbbob/settings.json to override)

## Steps

*(Mirror of intent.md's Steps, with live status; CLI-maintained, not hand-edited.
`build`/`checkpoint`/`revert` re-render this from intent.md, and set the Current step
line above. Only ONE step is in flight; a step is done only after a checkpoint:
check green + checkpoint taken, via `/plumbbob:verify` or `/plumbbob:build`.)*

- ☑ 1. feat(config): parse the effort ladder and the critic's effort
- ☑ 2. feat(loop): run the builder at the iteration's rung and the critic at its effort
- ☑ 3. feat(summary): record each iteration's rung and why it climbed
- ☑ 4. docs(readme): the effort ladder
- ☑ 5. feat(tester): the tester seat's config, prompt and tools
- ☐ 6. feat(flow): the test phase before the first build, red check required
- ☐ 7. feat(critic): the critic reads the tester's test
- ☐ 8. feat(acp): the tester under `volley acp`, and its docs
- ☐ 9. feat(protocol): the runciter.run/1 schemas and the input mapping
- ☐ 10. feat(cli): `volley run --protocol runciter.run/1`
- ☐ 11. docs(protocol): the protocol mode and its conformance fixture
- ☑ 12. fix(resume): keep the effort ladder and critic effort across a resume

## Park list

> Mid-step, every new problem / idea / "ooh what if" lands HERE, untouched, and you
> go straight back to the step. Acting the instant an idea arrives is the disease.
> Capture is one line (`/plumbbob:park` composes it). Harvest happens only at the boundary.

- [x] effort_ladder and critic_effort aren't written to config.json (workspace.ts) or read back by load_resume_state (iteration.ts), so a resumed run loses its ladder unless VOLLEY_EFFORT_LADDER is set; step 2's resume work needs both, and its seam lacks workspace.ts

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

- 2026-11-09, at range 1 of 3's stop: 1 parked idea, classified.
- **blocker**: park 1 · effort_ladder and critic_effort aren't written to config.json (workspace.ts) or read back by load_resume_state (iteration.ts), so a resumed run loses its ladder unless VOLLEY_EFFORT_LADDER is set; step 2's resume work needs both, and its seam lacks workspace.ts → D2 promises a resume reads the rung back, and a resumed laddered run silently drops the ladder it's counting on

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
- 2026-11-09 — step 3 checkpointed · a30cc944e — feat(summary): record each iteration's rung and why it climbed (1 drift, 2m)
- 2026-11-09 — step 4 checkpointed · 56245a725 — docs(readme): the effort ladder (2m)
- 2026-11-09 — range 1 of 3's stop recorded — run the ladder once on a real task with Claude seats and read the rung lines; decide whether a default ladder (`low,medium,high`) should be on for every run, or stay opt-in

  **Summary**: The effort ladder is built end to end, and it's opt-in. `--effort-ladder low,medium,high` runs build *k* at rung *k*, and the top rung repeats. A build climbs only after one that didn't end the run, and it records why: `check_failed`, else `critic_rejected`. `--critic-effort` sets the critic's effort apart, defaulting to `high` once a ladder is set. On `claude_cli` the effort reaches Claude Code as `CLAUDE_CODE_EFFORT_LEVEL`. Each build prints `[iter n] rung medium (climbed: check_failed)`, the archives and `summary.json` record `rung`, `climbed`, `effort_ignored`, `rungs` and `ladder_flat`, and the README documents all of it. With no ladder, neither seat is sent an effort, so the claude_cli arm is unchanged, and a test asserts it.

  1. Step 1's commit also picked up the three untracked research notes.
  2. `effort_ignored` comes from volley's own provider list, because fascicle reports it only to the trajectory.
  3. fascicle fixes a call's effort when the step is built, so the flow holds one builder leaf per rung.
  4. The climb reason depends only on the check, which is also what a resumed run can see.
  5. A resumed run loses its ladder, so the README states the limit.

  **Readout**:

  ```text
  steps        4 of 4 landed
               - 1 67bd551 · 2 da206c5 · 3 a30cc94 · 4 56245a7
  check        green: 1 of 1 checks, 4 landings
  done-when    met
  decisions    honored:
               - D1 (rung-is-effort), D2 (climb-on-failure), D3 (critic-effort-apart)
               - D4 (ladder-off-by-default), D16 (claude-effort-env)
               - D23 (ladder-flat-on-local)
  constraints  9 of 9 honored
  seam         strayed: 12 paths outside 3 steps' seams
               - step 1: research/capability-vs-enforcement.md and 4 others
               - step 2: src/flow.ts, test/integration/claude_cli_seat.test.ts
               - step 3: src/phases.ts and 4 others
  diff         +1546 -37 across 27 files
               - README.md +43 -1
               - research/capability-vs-enforcement.md +122 -0
               - research/effort-ladder-and-ensemble.md +90 -0
               - research/specialist-seats-and-equilibrium.md +154 -0
               - src/builder.ts +40 -6
               - src/cli.ts +32 -3
               - src/config.ts +96 -0
               - and 20 more
  spent        17 min · green first run at every landing · 3 drift warnings
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Harvested**: **1** of 1 parked idea open

  | Park | Why it matters | Lean |
  | --- | --- | --- |
  | **P1**: [Resume drops the ladder](#park-list) | a resumed laddered run silently loses its effort, and step 5's `tester` settings will hit the same gap | blocker: D2 promises a resume reads the rung back, and a resumed laddered run silently drops the ladder it's counting on |

  **Recommendation**: Keep the ladder opt-in, and settle P1 as a blocker so the resume fix lands first in range 2. A default ladder would send the critic `high` on every run and change the builder's effort, which breaks D4 (ladder-off-by-default) and the C4 (claude-arm-unchanged) control that cross-seat comparisons rely on, and nothing yet shows a ladder converges cheaper. For the stop's real run, rebuild first and drive reckon on Claude seats, then read the `rung` lines on stderr and `comparison.rungs` in the summary:

  ```sh
  cd ~/Projects/volley/code/volley && pnpm build
  cd ~/Projects/volley/code/reckon && node ../volley/dist/cli.js --config volley/volley.config.ts --builder-provider claude_cli --builder-model sonnet --critic-provider claude_cli --critic-model sonnet --effort-ladder low,medium,high
  ```

  **1.** Step 1's commit also picked up the three untracked research notes.

  The checkpoint stages everything outside `.gitignore`, so `research/capability-vs-enforcement.md`, `research/effort-ladder-and-ensemble.md` and `research/specialist-seats-and-equilibrium.md`, untracked when the run started, landed in `67bd551 feat(config)`. They're the sources this plan was written from, so nothing wrong is in the tree, but they ride a feat commit rather than a docs one. Nothing is pushed, so a rebase could split them out if that matters to you.

  **2.** `effort_ignored` comes from volley's own provider list, because fascicle reports it only to the trajectory.

  Step 2's done-when says a seat "whose adapter reports `effort_ignored`" is marked on the iteration. fascicle's ollama and lmstudio adapters do return `effort_ignored`, but the engine only records it as a trajectory event, and nothing on `GenerateResult` carries it. So `ignores_effort(provider)` in `src/config.ts` names ollama and lmstudio, the same two whose `translate_effort` ignores every level, and it drives step 1's warning, the builder and critic records, and `ladder_flat`. If fascicle adds a provider that ignores effort, this list has to learn about it. Reading it off the result would need a fascicle change.

  **3.** fascicle fixes a call's effort when the step is built, so the flow holds one builder leaf per rung.

  `model_call` takes `effort` only at construction, with no per-call override. `make_builder_ladder` builds a `builder` leaf for each rung the first time it's needed, all with the id `builder` so the stream and acp route them the same way, and `build_phase` picks the leaf by the build's rung. That meant a small change to `src/flow.ts`, outside step 2's seam: the arm became the first build's leaf. Without a ladder that arm is exactly today's builder, and the flow diagram test still passes untouched.

  **4.** The climb reason depends only on the check, which is also what a resumed run can see.

  A build that didn't end the run either failed its check or was sent back by the critic, so `climb_reason` returns `check_failed` when the last check failed and `critic_rejected` otherwise. The first version also read the last verdict, which broke on resume: `load_resume_state` keeps the last check but sets the verdict to null. A resumed run reads `builds`, `rung` and `climbed` back from the last iteration's `summary.json`, and an archive older than the count is read as one build per iteration.

  **5.** A resumed run loses its ladder, so the README states the limit.

  `effort_ladder` and `critic_effort` aren't written to `config.json` (`src/workspace.ts`), and `load_resume_state` doesn't read them back, so `volley resume` on a laddered run sends no effort unless `VOLLEY_EFFORT_LADDER` is set again. The rung count does survive (item 4), so setting the variable puts the run back on the right rung. That's parked as P1. The README's Resume section says so, because T4 (truthful-docs) wants limits stated.

  The proposed fold, if P1 is a blocker: a new step that builds ahead of step 5 in range 2, `fix(resume): keep the effort ladder and critic effort across a resume`, with seam `src/workspace.ts`, `src/iteration.ts`, `test/integration/resume.test.ts` and `README.md`. It's done when `config.json` records both fields, `load_resume_state` reads them back, a resume test runs build 3 at the third rung with no env var set, and the README's limit line is gone. Going first sets the pattern step 5's `tester` and `tester_model` settings need, since they'll have to survive a resume too.

- 2026-11-09 — step 12 checkpointed · ad455eef6 — fix(resume): keep the effort ladder and critic effort across a resume (3m)
- 2026-11-09 — step 5 checkpointed · 077903295 — feat(tester): the tester seat's config, prompt and tools (1 drift, 14m)
