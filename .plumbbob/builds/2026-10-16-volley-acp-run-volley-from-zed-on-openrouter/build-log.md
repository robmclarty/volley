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

# Build log: volley acp: run volley from Zed on OpenRouter

**Current step:** 1 — feat(provider): add an openrouter seat provider
**Heavy check:** checkride (set a "check" key in .plumbbob/settings.json to override)

## Steps

*(Mirror of intent.md's Steps, with live status; CLI-maintained, not hand-edited.
`build`/`checkpoint`/`revert` re-render this from intent.md, and set the Current step
line above. Only ONE step is in flight; a step is done only after a checkpoint:
check green + checkpoint taken, via `/plumbbob:verify` or `/plumbbob:build`.)*

- ☐ 1. feat(provider): add an openrouter seat provider
- ☐ 2. feat(orchestrator): inject seat tools, approval, and a trajectory sink
- ☐ 3. feat(state): add --state-dir to keep run state out of the workspace
- ☐ 4. feat(acp): give acp seats fascicle's workspace tools and prompts
- ☐ 5. feat(acp): serve volley to Zed as an ACP agent
- ☐ 6. feat(acp): show rounds, the check, and the verdict in Zed
- ☐ 7. feat(acp): ask before uncontained commands and hide provider keys
- ☐ 8. test(acp): drive a whole volley turn through an in-process ACP client
- ☐ 9. docs(readme): document volley acp, OpenRouter, and the Zed setup
- ☐ 10. test(acp): script and pass the live check in Zed

## Park list

> Mid-step, every new problem / idea / "ooh what if" lands HERE, untouched, and you
> go straight back to the step. Acting the instant an idea arrives is the disease.
> Capture is one line (`/plumbbob:park` composes it). Harvest happens only at the boundary.

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

- 2026-10-17 — plan committed · 02c41345f

  **Recommendation**: Approve it. All 14 open questions are resolved. The cold read's three findings settled as Q7, Q14, and Q9. Refine's five more are folded into D1, D7, D14, D26, and D27. Step 2's file list names `src/diagram.ts`. No decision is left without a reason, and no step's file list misses a file the code says must change.

  **1.** The check runs code the builder can edit without asking, and D15 (command-gate) only gates `run_command` (settled as Q7: D25 makes the check ask)

  D15 promises that, uncontained, no builder command runs unasked. But volley's own check is a `spawn_capture`, not a tool call, so no gate touches it. In Accept edits or Auto, the builder can rewrite a test or `package.json`'s `test` script without asking, and the next check runs it with no prompt. D16 (key-strip) keeps the keys out of its environment but not its reach: SSH keys, other repos, and the network.

  Routing the check through `session.approve` isn't a small change. The approver anchors its prompt on a card it learned from a `model_chunk` `tool_call_start`, which the check's emitted card never produces, so the prompt would float. There are two ways to close this:
  - give the check a real approval path when uncontained, and say how its card registers;
  - or state in D15 and the README that the check is the one command that runs unasked, because the user configured it with `--check`.

  **2.** Step 5 is too large to review in one pass (settled as Q14: kept whole, with the seat-option lift moved into step 1)

  Step 5 lands all of these in one diff:
  - the `serve_acp` config and the per-session flow;
  - the run command's seat options lifted into a shared helper;
  - four refusals, plus the missing-seat-flag refusal from D24 (acp-seats-required);
  - the SDK pin and its fallow handling (D17);
  - a spawn test;
  - an in-process turn test with a new client helper.

  Splitting it would keep each review to one idea. For example: first the CLI option lift with the `acp` command's flags and refusals, proven by the spawn test; then the per-session flow, with its routing and state root, proven by the in-process turn.

  **3.** D10 (turn-task) repeats every @-mentioned file in every later turn, twice (settled as Q9: earlier turns drop their file text; step 2's file list now names `src/diagram.ts`)

  `turn.history` keeps each user entry's full `turn.text`, and that includes a `<context ref>` block with the text of each file the user @-mentioned. D10 renders user entries whole and also makes the rendered conversation the criteria. So a file attached in turn 1 rides in both the builder's task and the critic's prompt on every later turn. A 32k-context local critic can overflow on that.

  Closing it means rendering a user entry without its `<context>` blocks, since the file is on disk, or cutting user entries the way agent entries are cut. Smaller: step 2's seam misses `src/diagram.ts`, which builds `FlowDeps` with `engines:` and must follow the rename. The typechecker catches it.
