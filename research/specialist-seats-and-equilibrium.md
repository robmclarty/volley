# Specialist seats, and the loop that stops at equilibrium

A research note, 2026-11-08, following `effort-ladder-and-ensemble.md`. Two questions from
Rob: would seats beyond builder and critic raise the quality of the first build, and what
would an outer loop around the ensemble look like that iterates until no ensemble can
improve the result any more. Nothing here is built.

## Why volley

Both are seat arrangements, and the phase tree in the README (`iteration → build → check
→ critique → record`) is the place a seat is added. A step is a bounded task with criteria,
a check and a judge; the loop's value is the verification around the agent, and that is
what a new seat extends. Decomposing a task belongs above volley, in a planner; in-step
planning belongs inside the agent session, which does it already; memory across
iterations is deliberately absent, since fresh sessions are what keep the loop legible.
A seat that would add any of those is in the wrong place.

**The rule for admitting a seat:** it earns its place by producing an artifact the check
can run, not another opinion. A doc seat that writes a doctest qualifies; a second
reviewer does not.

## The tester seat

`tester` runs first in an iteration, before the builder, and writes a failing test from the
task's criteria. The phase tree becomes:

```
iteration
├─ test        tester writes the test from the criteria; the check MUST go red
├─ build       builder runs with the red test in view
├─ check       MUST go green
├─ critique    critic judges the diff against the criteria and the test
└─ record
```

- **Red before green is a deterministic signal.** A test that passes before the builder
  touches anything means the task is already done or the test is vacuous. Either way the
  iteration ends with `tester_test_passed_early` in the summary and no builder spend
  (P1, fail-before-spend), and a harness treats it as a signal to stop.
- **The test is the criteria made unarguable.** The critic judges prose criteria, and
  prose is negotiable in a way a red test is not. The critic still runs: it reads the test
  too, and a test that does not test the criteria is a finding.
- **The tester is read-only on source, write-only on tests.** Its workspace tools write
  under the test paths the check names (or `--test-paths`), and nothing else. The
  containment story for the builder covers it unchanged.
- **Effort.** The tester runs at the critic's effort, not the builder's rung. Writing the
  right test is reading work, and cheap compared to the build it prevents.
- **Where there is no check,** `--check none`, there is no tester; the seat exists to feed
  the check.
- **Reported:** per iteration, whether the tester ran, the test paths it wrote, and whether
  the check went red. `summary.json` counts `tester_test_passed_early`.
- **`--tester off`** keeps today's loop. The default once the seat has run on real tasks is
  on wherever a check exists.

Because: the builder's first attempt is the one that sets the quality of everything after
it, and the cheapest way to raise it is to hand the builder a concrete definition of done
before it starts.

## The outer loop: `volley optimize`

The ensemble (N builders, the critic selects) is an inner loop. The outer loop is a
hill-climber over it:

```
volley optimize --objective "<command that prints a number>" \
  --builders 3 --rounds 10 --patience 2 [--direction min|max]
```

Round *r* runs an ensemble on the current base; the critic selects the best candidate; the
objective is measured on it; if it improves on the base, the candidate becomes the base.
The loop ends when `patience` consecutive rounds produce no improvement, or at `rounds`.
The result is the best base, its objective value, and the per-round record.

**The objective is a number the critic does not produce.** A benchmark's time, a test
count, a bundle size, a mutation score, a fixed rubric scored by a model other than the
builder with a fixed prompt. "No ensemble produced an improvement" means something only
against that number; without it, a plateau is the critic's mood. The `optimizer` critic
exists already and reads the objective's output as part of its context; what this note
adds is the loop around it and the stop condition.

**The reviewer stays as a veto.** An optimizer trades away whatever the objective does not
measure; this is the default failure, not an edge case. Each round's selected candidate
goes through the `reviewer` critic before it may become the base, and a rejection there is
a round with no improvement. Both critics' verdicts are in the round's record.

**Equilibrium is reported, not declared.** The summary says why the loop ended
(`patience`, `rounds`, `budget`, `reviewer_rejected_all`), the objective's curve, and how
many candidates each round discarded (P3, partial-is-data).

**Local models are where this pays.** N× builder cost on local hardware is time, not
money, and local attempts vary more between runs than cloud ones, which is when selection
beats a single attempt. The first experiment, on searle: one task, 1 vs 3 vs 5 local
builders, a local critic selecting, a Claude critic as ground truth on the selections. It
is cheap and it says whether the ensemble is worth anything before anything else is built.

Because: a loop that stops on a measurement can run unattended, and one that stops on an
opinion cannot.

## On itself

The loop can run on volley, with three walls that are not optional:

1. **The objective is external.** The repo's `pnpm check` green, plus a benchmark: a fixed
   set of past runs with known-good verdicts, scored by agreement. Never a number a seat in
   the loop produces.
2. **The contract is immutable to the loop.** `keyframes.md`'s Constraints hold and are
   checked by the gate; a candidate that changes the plan is rejected before the objective
   is read.
3. **The result lands on a branch a person promotes.** The loop never writes to `main`.

The realistic first version optimizes **configuration, not code**: the critic's prompt,
against a labelled set of past iterations, scored by how often its verdict matches the
label. It is safe, measurable and useful, and if it works, code is the next experiment,
with the same walls.

## Memory, and what the loop keeps

Volley keeps iteration memory only (`feedback.md`, the failed check's output), and it dies
with the run. Two things from these loops are worth keeping beyond it, and both leave
through the `runciter.run/1` result as `data` for a host to record as lessons:

- **Why the losers lost.** The critic's notes on the N−1 discarded candidates in an
  ensemble, scoped to the task. The cheapest lessons in the system, and nobody records them
  today.
- **The objective curve and the stop reason** from an optimize run, so the next run on the
  same objective starts with the knowledge of where the last one plateaued.

Volley itself stores neither; it reports them (P2, report-not-refuse applies to memory as
to everything else).

## Interactions

- P1: `--dry-run` probes the tester and the objective command (it must print a number on
  the current base).
- P3: an optimize run that ran out of budget reports the best base so far and the curve.
- P4: a local tester with no tool support falls back to writing the test from the criteria
  in one shot, and the summary says so.
- `effort-ladder-and-ensemble.md`: the tester runs once per iteration regardless of rung;
  the ensemble's N builders share one tester's test.
- `capability-vs-enforcement.md`: the tester's write paths are a capability the host may
  narrow further.
- Runciter: an optimize run is one Build run with one result; the rounds are `data`.

## Sized

1. **The tester seat**: the phase, the red-check requirement, write paths, `--tester`,
   reporting. 2 steps.
2. **`volley optimize`**: the loop, `--objective`, `--patience`, the reviewer veto, the
   curve in the summary. 2 steps, after the ensemble exists.
3. **Discarded-candidate notes as `data`** on the result. 1 step, with the ensemble.
4. **The searle experiment**: a script in `examples/` and its numbers in this note. Half a
   day, before 2.
5. **Self-optimization of the critic prompt**: the labelled set, the scorer, the branch.
   2 steps, last, and only once 2 has run on something else.
