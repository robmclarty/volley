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

**Current step:** 10 — feat(cli): `volley run --protocol runciter.run/1`
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
- ☑ 6. feat(flow): the test phase before the first build, red check required
- ☑ 7. feat(critic): the critic reads the tester's test
- ☑ 8. feat(acp): the tester under `volley acp`, and its docs
- ☑ 9. feat(protocol): the runciter.run/1 schemas and the input mapping
- ☐ 10. feat(cli): `volley run --protocol runciter.run/1`
- ☐ 11. docs(protocol): the protocol mode and its conformance fixture
- ☑ 12. fix(resume): keep the effort ladder and critic effort across a resume

## Park list

> Mid-step, every new problem / idea / "ooh what if" lands HERE, untouched, and you
> go straight back to the step. Acting the instant an idea arrives is the disease.
> Capture is one line (`/plumbbob:park` composes it). Harvest happens only at the boundary.

- [x] effort_ladder and critic_effort aren't written to config.json (workspace.ts) or read back by load_resume_state (iteration.ts), so a resumed run loses its ladder unless VOLLEY_EFFORT_LADDER is set; step 2's resume work needs both, and its seam lacks workspace.ts
- [ ] resolve_config reads a prompt or criteria starting with '@' as a file path (expand_at_file), so a RunInput whose task.criteria or agent.prompt opens with '@' would fail or read the wrong file; protocol mode should hand them over as <run_dir>/prompt.md and criteria.md @-paths, as runciter's volley kind does
- [ ] protocol mode ignores --dry-run and runs anyway (D13 refuses only --worktree, --git, --json and a positional prompt); a dry run there exits 0 with no RunOutput unless it is refused or answered, so it wants a ruling: refuse it with exit 2, or make it a preflight that reports as a RunOutput

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
- 2026-11-09 — step 6 checkpointed · d06383a7f — feat(flow): the test phase before the first build, red check required (1 drift, 11m)
- 2026-11-09 — step 7 checkpointed · 4b8287fe8 — feat(critic): the critic reads the tester's test (1 drift, 3m)
- 2026-11-09 — step 8 checkpointed · d0492144a — feat(acp): the tester under `volley acp`, and its docs (1 drift, 593m)

  **Summary**: Under `volley acp` the tester now takes fascicle's reads and its two writes, held to the test and fixture paths, so each test write asks with its diff as the builder's edits do, and a write it may not make is refused before anyone is asked. Its work shows as **Round 1: the tester's test**, then **Round 1: the build**. A `claude_cli` tester is refused at startup, by flag or by `VOLLEY_TESTER`, and the README gains The tester seat, with its containment, the Usage rows and the acp notes. The loose ends are closed too: `keyframes.md`'s C2 now names the tester, as you asked.

  1. The tester's acp writes wrap fascicle's, so a refused path never reaches a prompt
  2. The round the tester opens has two lines, and a tester failure names its phase
  3. `--check auto` with the tester can't be judged at acp startup, so each prompt judges it
  4. The loose ends: C2 names the tester, the state root holds only your runs, and the acp gap is closed
  5. Beyond the seam, to make the seat reachable

  **Readout**:

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    honored:
               - D14 (tester-contained), D17 (tester-first-iteration)
               - D19 (tester-claude-permissions), D20 (tester-tests-and-fixtures)
  constraints  9 of 9 honored
  seam         strayed: 12 paths outside the seam
               - keyframes.md
               - src/cli.ts
               - src/flow.ts
               - src/orchestrator.ts
               - src/phases.ts
               - src/tester/prompt.ts
               - src/tester/run.ts
               - src/tester/tools.ts
               - test/integration/acp_cli.test.ts
               - test/integration/acp_turn.test.ts
               - test/unit/acp_progress.test.ts
               - test/unit/acp_tools.test.ts
  diff         +444 -45 across 16 files
               - README.md +58 -3
               - keyframes.md +5 -4
               - src/acp.ts +34 -5
               - src/acp_progress.ts +17 -6
               - src/acp_tools.ts +47 -2
               - src/cli.ts +2 -0
               - src/flow.ts +4 -3
               - and 9 more
  spent        9h 53m · 3 turns · 17s gate · green first run
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Approve it. The tester is reachable everywhere it should be and refused where D19 says it must be, and the acp turn test drives the whole path through the SDK client, which is the strongest evidence short of Zed. `looks good` lands step 8, which completes range 2, so its stop card follows. That stop is yours to run: the tester on two real tasks, one on checkride and one on a shell command, then its default.

  **1.** The tester's acp writes wrap fascicle's, so a refused path never reaches a prompt

  `acp_seat_tools` gains a `tester` seat: `read_file`, `list_files` and `search`, plus `write_file` and `edit_file` wrapped by `confined()`. For a path the tester may not write (outside the gate's test and fixture patterns, `package.json`, a `*.config.*` file, `.github/`, an escape, or a symlink), `needs_approval` answers no and `execute` throws the same message volley's own writers give, so Zed never asks about a write that can't land. Every other call goes through the original `needs_approval`, which is how fascicle knows the call as its own and draws the edit card with its diff. The check uses one function, `tester_refusal`, for this path and volley's own tester tools, so the two can't drift. The tester's system prompt names fascicle's tool set and says a declined write isn't made, and its approvals go through `session.approve`, as the builder's do. The end-to-end turn test shows the test write asking first with its diff, a write to `src/` refused with no prompt, and the tester's reply kept out of the thread, as the critic's is.

  **2.** The round the tester opens has two lines, and a tester failure names its phase

  `test_phase` now emits a `test_start` event, and the build in that round still emits `round_start`, marked `after_test`. So acp shows **Round 1: the tester's test**, the tester's cards, the red check, then **Round 1: the build**. In step 6 the tester had emitted iteration 1's `round_start` and the build none. That changes the CLI trajectory too, with one more event in a tester run's first round, and a reader counting `round_start` still sees one per round. `follow_rounds` counts `test_start`, so a tester that dies reads as failed in round 1, during the tester's test. A run stopped by `tester_passed_early` ends with its own line.

  **3.** `--check auto` with the tester can't be judged at acp startup, so each prompt judges it

  The startup check resolves the whole config against the temp directory, where `--check auto` finds nothing, and the tester's need for a check (D18) would refuse every `--tester on --check auto` before any folder was open. So the startup check stands a command in for `auto`. Each prompt's run resolves the real check against the session's folder, and a folder with no check fails that prompt with the reason. `--check none` with the tester is still refused at startup. This is a judgment call the plan didn't spell out, and the README says how it behaves.

  **4.** The loose ends: C2 names the tester, the state root holds only your runs, and the acp gap is closed

  `keyframes.md`'s C2 reads "A builder other than `claude_cli`, and a tester on any provider but `claude_cli`, runs only inside the sandbox…", its because adds that the check runs what a tester writes, and its held-by gains `config.test.ts#"refuses a local tester uncontained and not opted out"`. `keyframes check` reports no findings. The test setup already points `XDG_STATE_HOME` at a temp folder, so only a test that passes `env: {}` to a run could reach your real state root, and the two that do now pin `state_dir: null`. `~/.local/state/volley` holds your five older runs and nothing else. The `VOLLEY_TESTER=on` gap under acp is what this step closes.

  **5.** Beyond the seam, to make the seat reachable

  - `src/tester/`: `tester_refusal`, the acp tools paragraph, `tool_set` and `on_tool_approval` on the tester's call.
  - `src/flow.ts` and `src/orchestrator.ts`: the tester seat type, and the seat passed through.
  - `src/phases.ts`: the two events.
  - `src/cli.ts`: `--tester` and `--tester-model` on `volley acp`.
  - `keyframes.md` and the tests.
- 2026-11-09 — range 2 of 3's stop recorded — run the tester on two real tasks, one on checkride and one on a shell command, and decide its default: on wherever a check exists, or off

  **Summary**: The tester seat is built end to end, and it's off by default. With `--tester on`, the run's first iteration opens with a tester on the critic's seat writing a failing test under the test and fixture gate paths, and then the check, which must fail. A red check goes on to the build, whose prompt names the tester's files and shows the failure. A green check ends the run as `tester_passed_early` (exit 2) with no build, and a tester that crosses the cost cap ends it before the check. The tester's spend, writes and file hashes are recorded apart, so its test isn't a builder gate edit unless a build changes it. The critic judges the test too, as `test_findings`. Under `volley acp` its writes ask as the builder's do, in a round of their own, and a `claude_cli` tester is refused. First, step 12 made a resume keep the effort ladder and the critic's effort. The README documents all of it, and `keyframes.md`'s C2 now names the tester.

  1. Step 5 confined the tester further than the plan named
  2. Every run now passes through two branches, the tester off included
  3. The reviewer preset's tester paragraph reaches every reviewer run
  4. Under `volley acp`, the tester's need for a check is judged per prompt
  5. The real runs will test the red-check rule unevenly

  **Readout**:

  ```text
  steps        5 of 5 landed
               - 12 ad455ee · 5 0779032 · 6 d06383a · 7 4b8287f · 8 d049214
  check        green: 1 of 1 checks, 5 landings
  done-when    met
  decisions    honored:
               - D29 (resume-keeps-ladder), D8 (tester-off-by-default)
               - D7 (tester-at-critic-effort), D15 (tester-model-override)
               - D14 (tester-contained), D18 (tester-needs-check)
               - D19 (tester-claude-permissions), D20 (tester-tests-and-fixtures)
               - D6 (red-before-green), D17 (tester-first-iteration)
               - D9 (tester-changes-apart), D21 (tester-cost-apart)
               - D22 (tester-hashes)
  constraints  9 of 9 honored
  seam         strayed: 38 paths outside 4 steps' seams
               - step 5: package.json and 8 others
               - step 6: src/acp_progress.ts and 9 others
               - step 7: README.md and 6 others
               - step 8: keyframes.md and 11 others
  diff         +2816 -224 across 53 files
               - README.md +106 -29
               - keyframes.md +5 -4
               - package.json +1 -0
               - src/acp.ts +34 -5
               - src/acp_progress.ts +18 -6
               - src/acp_tools.ts +47 -2
               - src/builder.ts +48 -0
               - and 46 more
  spent        10h 25m · green first run at every landing · 4 drift warnings
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Keep the tester off by default for now, and decide after both runs. "On wherever a check exists" would spend a seat's session on every run, and on a gate that starts red, such as reckon's, it proves little. Rebuild first, then run the shell-command task on reckon with the tester on:

  ```sh
  cd ~/Projects/volley/code/volley && pnpm build
  cd ~/Projects/volley/code/reckon && node ../volley/dist/cli.js --config volley/volley.config.ts --builder-provider claude_cli --builder-model sonnet --critic-provider claude_cli --critic-model sonnet --tester on
  ```

  For the checkride task, pick a small feature in a checkride workspace whose check is green now, run it with `--tester on --worktree`, and read `iterations/001/summary.json`: `tester_check.ok` should be false, `tester_changes` should list only test files, and `critic.test_findings` says what the critic thought of the test.

  **1.** Step 5 confined the tester further than the plan named

  Three refusals beyond the done-when, each in the spirit of a decision already made. A write through a symbolic link is refused, since `contain()` is lexical and `test/` linked to `src/` would otherwise let an allowed write land in the source. `--tester on` with no test or fixture gate pattern is refused at config, as D18 refuses a missing check, under P1. And `config.json` records `tester` and `tester_model`, which a resume reads back, a recorded off staying off whatever `VOLLEY_TESTER` says, following D29's pattern. To serve the tester, `write_file` and `edit_file` moved into `src/workspace_tools.ts`, since the import rule bars `src/tester/` from `../builder/tools.js`; the builder's tools are unchanged, and C4's test holds.

  **2.** Every run now passes through two branches, the tester off included

  Step 6 put the test phase in the flow's own topology (C9): a `test` branch opens each iteration, and a `work` branch holds it with no build when the test phase ended the run. With the tester off, both pass straight through to today's build and verify, so the builder's and the critic's calls are unchanged, but a default run's trajectory carries two more spans per iteration, and the diagram in `flow.ts` and the README shows them. A tester failure exits 3, which the README's row now words "Builder, tester or provider error"; nothing in C6's table changes meaning.

  **3.** The reviewer preset's tester paragraph reaches every reviewer run

  Step 7's done-when puts the guidance on a vacuous test in `reviewer.md`, so every reviewer critic's system prompt gains it, tester or not. It opens "When your prompt names a tester's test", and the critic's prompt names one only in a run with a tester, whose prompt is otherwise byte-for-byte what it was. If you want the reviewer's system prompt untouched for comparisons with older runs, the paragraph could move into the tester section of the critic's prompt instead.

  **4.** Under `volley acp`, the tester's need for a check is judged per prompt

  The acp startup check resolves the config against the temp directory, where `--check auto` finds nothing, so it stands a command in for `auto` there; each prompt resolves the real check against its session's folder, and a folder with no check fails that prompt with the reason. `--check none` with the tester is still refused at startup. This was a judgment call, and the README says how it behaves.

  **5.** The real runs will test the red-check rule unevenly

  On reckon the gate is red before anyone writes, since its 29 tests are stubbed red, so the tester's check goes red whatever it writes, and `tester_passed_early` can't fire there. That run shows the tester's cost and whether its tests are sharper than the ones already in place, not whether red-before-green earns its keep. A checkride workspace whose check is green at the start, with a small new feature as the task, is where the red check proves the tester wrote a real test.

- 2026-11-09 — step 9 checkpointed · 7bd7c075e — feat(protocol): the runciter.run/1 schemas and the input mapping (5m)
