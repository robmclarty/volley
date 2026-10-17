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

**Current step:** 2 — feat(orchestrator): inject seat tools, approval, and a trajectory sink
**Heavy check:** checkride (set a "check" key in .plumbbob/settings.json to override)

## Steps

*(Mirror of intent.md's Steps, with live status; CLI-maintained, not hand-edited.
`build`/`checkpoint`/`revert` re-render this from intent.md, and set the Current step
line above. Only ONE step is in flight; a step is done only after a checkpoint:
check green + checkpoint taken, via `/plumbbob:verify` or `/plumbbob:build`.)*

- ☑ 1. feat(provider): add an openrouter seat provider
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

- 2026-10-17 — step 1 checkpointed · 2f27571ff — feat(provider): add an openrouter seat provider (12m)

  **Summary**: Both seats can now run on OpenRouter from the plain CLI with one `OPENROUTER_API_KEY`, through fascicle's native transport and under the same containment gate and preflight as a local builder, and the run command's seat options now come from one helper that `volley acp` can reuse.

  1. An openrouter seat gets its whole provider entry from one URL row and one key
  2. OpenRouter already took the non-claude_cli branch, so most of the spec's branch points only needed comments
  3. The integration test runs both seats against stand-in OpenRouter servers over SSE
  4. Three existing messages now read provider-neutral, a judgment call under C5 (cli-unchanged)
  5. The seat options moved into one helper, and a test pins the run command's option order

  **Readout**: Step 1 - feat(provider): add an openrouter seat provider

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    honored
               - D3 (openrouter-entry)
               - D4 (openrouter-seat)
               - D9 (acp-flags)
  constraints  6 of 6 honored
  seam         held: 17 of 17 declared, no strays
  diff         +754 -121 across 17 files
  spent        12 min · 1 turn · 10s gate · green first run
  ```

  **Verdict**: ● Plumb

  **Recommendation**: Approve and land step 1. Every clause in the done-when has a test behind it and the check is green; the only change to existing behavior is the wording in highlight 4.

  **1.** An openrouter seat gets its whole provider entry from one URL row and one key

  `src/engine.ts` gains a `SEAT_URL_SOURCES` row for `openrouter` (`VOLLEY_OPENROUTER_URL`, default `https://openrouter.ai/api/v1`, trailing slashes stripped) and an `openrouter` case in `seat_provider_config` that returns `{ api_key, base_url, transport: 'native', x_title: 'volley' }`. A critic engine derived with `with_providers` therefore keeps the key and the transport, as D3 (openrouter-entry) requires. `openrouter_api_key` reads the key and throws a config error naming `OPENROUTER_API_KEY` when it is unset or blank. `resolve_config` calls it whenever either seat is on openrouter, so `--dry-run`, `resume`, and `matrix` all refuse with exit 5 before any work, which is what step 5's startup resolve (D27) will lean on.

  **2.** OpenRouter already took the non-claude_cli branch, so most of the spec's branch points only needed comments

  The builder's system prompt and tool options, the critic's read tools, its retry and degrade ladder, and its harness preset all branch on `claude_cli` versus everything else, so an openrouter seat lands on the tool-loop side with no new code, as D4 (openrouter-seat) asks. The Ollama-only prewarm and context probe stay Ollama-only. The real code changes are elsewhere:
  - the containment gate's provider list, renamed `TOOL_LOOP_BUILDER_PROVIDERS`;
  - preflight's `is_local_builder`, renamed `is_tool_loop_builder` (not in the public API) so the toolchain and worktree checks apply to an openrouter builder;
  - `is_local_critic`, left excluding openrouter, so no paid canary runs;
  - `Transport`, which gains `'native'` for `transport_of('openrouter')`.

  The comments in the builder, critic, and prompt modules now say "local or openrouter" where they said "local model".

  **3.** The integration test runs both seats against stand-in OpenRouter servers over SSE

  `test/helpers/openai_stub.ts` answers `POST …/chat/completions` with SSE frames, usage on the last frame before `[DONE]`, the shape fascicle's `openrouter_native` tests use. It records each request's method, path, model, stream flag, `authorization`, and `x-title`. `test/integration/openrouter.test.ts` checks three things:
  - a run with each seat on its own stub succeeds; each stub sees exactly one streamed `POST /v1/chat/completions` carrying `Bearer sk-or-test`, `X-Title: volley`, and its own model; and `summary.json` records both transports as `native`;
  - with no seat URL, both seats go to `VOLLEY_OPENROUTER_URL` (given with a trailing slash) and nothing reaches a second stub;
  - `preflight` sends one `GET /v1` to each seat's server and posts nothing.

  I dropped a non-streaming JSON branch I had first written into the stub, because nothing reaches it: volley's model calls always stream, and an openrouter critic runs no canary.

  **4.** Three existing messages now read provider-neutral, a judgment call under C5 (cli-unchanged)

  The containment refusal and the unsandboxed-builder warning said "runs a local model with a real bash". Both now say "runs volley's tool loop with a real bash" for every provider, Ollama included. The seat-URL refusal now names "ollama, lmstudio, or openrouter" (through `Intl.ListFormat`). The `--builder-max-steps` and `--allow-unsandboxed-builder` help lines no longer say "local". Exit codes, option names, and option order are unchanged, and the existing tests that match on `refused unless contained` still pass. If you'd rather keep the old wording for the local providers, it's a two-line change.

  **5.** The seat options moved into one helper, and a test pins the run command's option order

  `with_seat_options(command)` in `src/cli.ts` declares the eight seat options D9 (acp-flags) names, in their old positions, and the run command calls it between `--check` and `--builder-permission-mode`. A diff of `--help` taken before and after the change shows the same flags in the same order, with only the descriptions changed. `test/integration/cli.test.ts` now asserts the full ordered option list and that both provider lines list `openrouter`. It also spawns the CLI to check four things: an unset key exits 5 naming it, for both seats or the critic alone; an uncontained openrouter builder is refused; and a dry run prints each seat's resolved endpoint and names the one that's unreachable.
