# The effort ladder and the ensemble

A research note, 2026-11-08, from plumbbob's user feedback: the features people like
are the ones that save attention, juniors want speed, and Rob wants the effort of a
build chosen for the user with levers to override. Nothing here is built. The
plumbbob side is `research/14-acp-host-and-polished-ux.md` there, under "Attention:
effort follows decision density".

## Why volley

Both ideas are seat arrangements: how many builders, at what effort, judged by which
critic. That is what volley is. plumbbob binds a step to a builder and shows the
result; runciter schedules a run and gives it a worktree. Neither should know that
the builder tried twice or ran three times.

## The effort ladder

**Cheap hands, expensive eyes, and escalate on failure.**

- `--effort-ladder low,medium,high` (config `effort_ladder`): iteration *n* runs the
  builder at rung *n*, capped at the last rung, which repeats to `max_iterations`.
  Iteration 1 at `low` is fast; if the check is green and the critic approves, the
  run converges having spent little. A failure climbs one rung. A single value
  (`--effort high`) is a ladder of one, today's behaviour.
- **The critic's effort is separate and defaults high.** Reading a diff against the
  criteria costs far less than writing it, and the critic is what makes a cheap
  builder safe. `--critic-effort` stays independent of the ladder.
- **A fast critic first, optional.** `--critic-prefilter <model>`: a fast seat reads
  the diff for obvious defects before the real critic runs. A rejection there is
  cheap and quick; an approval hands off to the slow critic. Fast rejection is the
  speed juniors notice.
- **The rung is reported.** `summary.json` and the `--json` result carry, per
  iteration, the rung the builder ran at and why it climbed (`check_failed`,
  `critic_rejected`). A harness renders one line from it.
- **What the ladder is not.** A model switch. The seat's model stays; the rung is the
  provider's effort or thinking setting, where it has one (Claude's effort levels; a
  local seat's `num_predict` and thinking toggle where the backend exposes them).
  Where a seat has no effort control, the ladder is a no-op and the summary says so.

Because: a failed low-effort attempt wastes cheap tokens, a high-effort first attempt
wastes expensive ones on every step that did not need them, and most steps in a
settled plan do not.

## The ensemble

`--builders N` (config `builders`): N builder seats run the same task in parallel,
each in its own worktree on its own `volley/<run id>-<n>` branch, each through the
check. The critic reads all N diffs and all N check results against the criteria and
**selects one**. The others' branches are discarded as a non-converging run's would
be, and the critic's notes on them are recorded as lessons in `feedback.md`.

- **Select, not synthesize, by default.** A merge of three diffs is a fourth diff that
  none of the three builders tested. `--synthesize` opts in, and a synthesized result
  goes back through the check as its own iteration before the critic may approve it.
- **The ensemble is a rung, not a mode.** It pays only where variance between attempts
  is high, which is an ambiguous or risky step. A harness that computes a risk score
  (plumbbob's note describes one) asks for `--builders 3` above `high`; nobody turns
  it on for a whole build. Cost is N× the builder seat, and the summary says so.
- **Seats may differ.** `--builders 3 --builder-models a,b,c` runs different models,
  which is `volley matrix` with a critic choosing instead of a table. The two share
  the worktree-per-seat machinery and should be one code path.
- **Under ACP, one Round per builder**, streamed in order, the comparison as a
  thought, the chosen diff as the reply. Permission prompts for N builders' commands
  are N times the prompts; outside the container the ensemble is refused unless the
  session is in Auto mode and the builder is contained, since nobody can approve
  three builders' commands by hand.

Because: three answers and a judge beats one answer only when the answers would
differ, and the critic already exists to judge.

## Interactions with the rest of volley

- P1 (fail-before-spend): `--dry-run` probes every builder seat and the prefilter.
- P3 (partial-is-data): a ladder that ran out of rungs reports the best iteration and
  its rung; an ensemble whose critic rejected all N reports all N.
- P4 (local-first-class): a local seat with no effort control runs the ladder as
  iterations at one rung, and the summary says the ladder was flat.
- The sandbox note (`capability-vs-enforcement.md`): N builders are N contained
  processes or N `docker exec`s into one container; the host decides which.
- `runciter.run/1`: the result's usage and the chosen branch are what the host reads;
  the per-iteration rungs are `data`.

## Sized

1. `effort_ladder` on the builder seat, rung per iteration, reported in the summary.
   1–2 steps.
2. `--critic-prefilter`. 1 step.
3. `--builders N` with select; worktree per seat shared with `matrix`. 3 steps.
4. `--synthesize` as a checked iteration. 1 step, last, and only if selection proves
   insufficient on real steps.
