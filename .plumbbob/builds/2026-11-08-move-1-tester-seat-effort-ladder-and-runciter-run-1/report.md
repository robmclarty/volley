# Report: move 1: tester seat, effort ladder, and runciter.run/1

## What shipped

Three features, one range each, 12 steps in all (the build-log's `## Log` has them step by step):

- **The effort ladder** (range 1, steps 1-4, plus step 12 from its stop). `--effort-ladder low,medium,high` runs build *k* at rung *k*; the top rung repeats, and a build climbs only after one that didn't end the run, with the reason recorded (`check_failed`, else `critic_rejected`). `--critic-effort` sets the critic's effort apart. On `claude_cli` the effort reaches Claude Code as `CLAUDE_CODE_EFFORT_LEVEL`. The summary and each iteration's archive record `rung`, `climbed` and `effort_ignored`. Step 12 makes a resumed run keep its ladder and its critic's effort. The ladder is opt-in.
- **The tester seat** (range 2, steps 5-8). With `--tester on`, iteration 1 opens with a tester on the critic's seat. It writes a failing test into the test and fixture gate paths, and then the check must fail. A green check ends the run as `tester_passed_early` (exit 2) with no builder spend. The tester's spend, writes and file hashes are recorded apart, so its test doesn't count as a builder gate edit. The critic reads the tester's test, and `volley acp` runs the tester too. The tester is off by default.
- **runciter's run protocol** (range 3, steps 9-11). `volley run --protocol runciter.run/1` reads one `RunInput` on stdin and writes exactly one `RunOutput` on stdout, with `runciter.progress` and `runciter.usage` lines on stderr and the protocol's own exit codes. The README has a "Run volley from runciter" section, and `test/fixtures/runciter_run_input.json` is the conformance input. At range 3's stop, runciter's `process` kind ran it on the sandbox repo with a Claude seat. It ran 2 iterations, the critic approved, runciter's verify passed and committed `ff5287a1`, it cost $0.53, and `critic-feedback.md` was in the drawer.

`keyframes.md`'s M1 (cli) now lists `src/protocol/` and names the protocol mode. The edit was made at the human's request, after step 11 proposed it.

## Decisions and why

- **D1 (rung-is-effort)** and **D2 (climb-on-failure)**: a rung sets only fascicle's per-call `effort`, never the model, so a seat stays comparable across rungs. The rung climbs one step for each build that didn't end the run, because a cheap first attempt that fails wastes only cheap tokens.
- **D3 (critic-effort-apart)** and **D4 (ladder-off-by-default)**: with no ladder, the builder's and critic's call options are byte-for-byte what they were. That keeps the `claude_cli` arm the control that cross-seat comparisons rely on (C4). Range 1's stop kept the ladder opt-in for the same reason.
- **D16 (claude-effort-env)**: fascicle 0.17.7 already passes `effort` to Claude Code as an environment variable, so the claude arm needed no `extra_args` workaround.
- **D23 (ladder-flat-on-local)**: Ollama and LM Studio ignore effort. The ladder warns at config time and records `effort_ignored`, rather than inventing a local rung.
- **D29 (resume-keeps-ladder)**: harvested from range 1's P1 as a blocker and built first in range 2 as step 12, because D2 promises that a resume picks up the rung.
- **D5 (tester-writes-gate-only)**, **D20 (tester-tests-and-fixtures)** and **D19 (tester-claude-permissions)**: the tester writes tests and fixtures only, never `package.json`, `*.config.*` or `.github/`, and has no `bash`. A tester that could rewrite the check's config could choose its own result.
- **D14 (tester-contained)**: Q8 reopened this one. The check runs what the tester writes, so a tester on any provider but `claude_cli` needs containment, as a builder does.
- **D6 (red-before-green)** and **D17 (tester-first-iteration)**: a test that passes before the build is vacuous, or the work is already done, so the run ends as `tester_passed_early`. The tester runs in iteration 1 only, because its test stays in the workspace.
- **D9 (tester-changes-apart)**, **D21 (tester-cost-apart)** and **D22 (tester-hashes)**: the tester's writes, cost and hashes are kept apart from the builder's, so the gate-edit warning stays about the builder and the cost cap is checked after the test phase.
- **D8 (tester-off-by-default)**: range 2's stop kept it off. "On wherever a check exists" would spend a seat's session on every run, and nobody has run the tester on a real task yet.
- **D10 (own-schema-copy)**: volley carries its own zod copy of runciter's §5.4 and takes no dependency on runciter. Runciter's conformance test checks that the copies agree.
- **D11 (protocol-exit-table)** and **D28 (protocol-errors-as-output)**: protocol mode has its own exit table (0, 1, 2). A seat or check error still exits 0 with a failed `RunOutput`, which keeps the summary and `data` in runciter's drawer.
- **D12 (data-carries-summary)**: `RunOutput.data` is the whole `RunSummary`, and `summary` is a status line plus the critic's last feedback.
- **D13 (protocol-refuses-workspace-flags)** and **D27 (protocol-flag-only)**: runciter owns the workspace and stdout carries the protocol, so protocol mode refuses `--worktree`, `--git`, `--json` and a positional prompt. Only the flag switches the mode on; `RUNCITER_PROTOCOL` is ignored, so the check's own `volley run` tests aren't caught by it.
- **D24 (protocol-prompt-from-context)**, **D25 (protocol-check-from-verify)** and **D26 (protocol-state-in-run-dir)**: the input is mapped as runciter's `volley` kind maps it. The prompt is `agent.prompt` plus `context.md`, so a retried task sees why its last attempt failed. The check comes from `stage.verify`. State lives under `<run_dir>/volley`, outside runciter's diff and verify.

## Parked & harvested

| Park | Why it matters | Settled |
| --- | --- | --- |
| **P1**: [resume drops the ladder](build-log.md#L45) | a resumed laddered run silently sends no effort, against D2's promise | blocker: folded into the plan as step 12 and D29 (resume-keeps-ladder), and built first in range 2 |
| **P2**: [Leading `@` in criteria](build-log.md#L46) | a `RunInput` whose criteria or agent prompt opens with `@` fails as a missing file, which runciter's kind never did | tangent: real but rare, and this move's done doesn't need it; worth a volley issue before runciter's `volley` kind retires |
| **P3**: [Dry run in protocol mode](build-log.md#L47) | a protocol-mode `--dry-run` runs the task anyway, rather than refusing or answering with a `RunOutput` | tangent: no host sends `--dry-run` in protocol mode, so the ruling can wait for one that does |

## Final status

Done. All 12 steps landed on a green check, all three ranges' stops are recorded, and range 3's stop ran live from runciter. The ladder and the tester ship opt-in. Nobody has run the tester on a real task yet, so whether it should turn on wherever a check exists is still open.

## Deferred tangents

- **P2, leading `@` in criteria.** Protocol mode should hand the prompt and criteria over as `@`-paths to files in `<run_dir>`, as runciter's kind does. File it as a volley issue before runciter's `volley` kind retires.
- **P3, dry run in protocol mode.** Refuse it with exit 2, or answer with a preflight `RunOutput`, once a host sends it.
- **The trajectory viewer for `process` runs (runciter).** Found at range 3's stop and not parked. Runciter's drawer and daemon show fascicle's viewer only when the runner kind is `volley` (`web/src/detail/view.ts:143`, `src/viewers/trajectory.ts:49`). A protocol run's trajectory is already at `<run_dir>/volley/<run_id>/trajectory.jsonl`, so the check just needs to look for the file instead of the runner kind. This needs fixing in runciter before its `volley` kind retires.
- **The tester's default.** Run it on real tasks, one on checkride and one on a shell command, before deciding whether D8 (tester-off-by-default) should flip.

## Checkpoints

- baseline 30014834de20c47774e67395eae9dac2fffc69df
- step 1 67bd55109d2480416e9100ba015698ca4c36ec16
- step 2 da206c503469890cad8715ec2cd38348dc43cb51
- step 3 a30cc944e14f0068ea674b6065454b0fccc302c5
- step 4 56245a725acfc98839202adf2c5419ab9c03f603
- step 12 ad455eef6391fa5d0904518ba08c30b5ee62787a
- step 5 077903295b76f536e672db1ee8d18230fb608b78
- step 6 d06383a7ffc245b065a296020c378c6918fe53b9
- step 7 4b8287fe8dbe94ed8b3a247f48e74e4e34e11969
- step 8 d0492144a8d6ae11046231183851a87fe63b2e89
- step 9 7bd7c075e65271805fa3f0cee9b922f2f1b3dbbf
- step 10 f2dbc0a7954b592376760f2c9d5e412cba4cab85
- step 11 4a4bdea78073862c023f26ccf7421cf12cfd5e0d

## Stats

| step | red checks | drift warnings | reverts | wall-clock |
| ---- | ---------- | -------------- | ------- | ---------- |
| 1 | 0 | 1 | 0 | 6m |
| 2 | 0 | 1 | 0 | 6m |
| 3 | 0 | 1 | 0 | 2m |
| 4 | 0 | 0 | 0 | 2m |
| 5 | 0 | 1 | 0 | 14m |
| 6 | 0 | 1 | 0 | 11m |
| 7 | 0 | 1 | 0 | 3m |
| 8 | 0 | 1 | 0 | 593m |
| 9 | 0 | 0 | 0 | 5m |
| 10 | 0 | 1 | 0 | 11m |
| 11 | 0 | 0 | 0 | 6m |
| 12 | 0 | 0 | 0 | 3m |
| **total** | 0 | 8 | 0 | 662m |
