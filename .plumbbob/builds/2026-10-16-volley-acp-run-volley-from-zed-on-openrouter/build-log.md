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

**Current step:** 4 — feat(acp): give acp seats fascicle's workspace tools and prompts
**Heavy check:** checkride (set a "check" key in .plumbbob/settings.json to override)

## Steps

*(Mirror of intent.md's Steps, with live status; CLI-maintained, not hand-edited.
`build`/`checkpoint`/`revert` re-render this from intent.md, and set the Current step
line above. Only ONE step is in flight; a step is done only after a checkpoint:
check green + checkpoint taken, via `/plumbbob:verify` or `/plumbbob:build`.)*

- ☑ 1. feat(provider): add an openrouter seat provider
- ☑ 2. feat(orchestrator): inject seat tools, approval, and a trajectory sink
- ☑ 3. feat(state): add --state-dir to keep run state out of the workspace
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

- [x] a --state-dir inside the workspace shows up in the builder's change list and --git checkpoints, since changes.ts excludes only .volley/ and .volley.bak.*

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

- 2026-10-17, after step 3: "a --state-dir inside the workspace shows up in the builder's change list and --git checkpoints" → **tangent**, deferred. No step in this build reaches it: acp defaults the root to `$XDG_STATE_HOME/volley`, outside the repo (D5 (state-layout)), and the CLI with no flag still excludes `.volley/`. A later fix would exclude the root's path, relative to the build root, in `changes.ts`.

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

- 2026-10-17 — step 2 checkpointed · a692f835e — feat(orchestrator): inject seat tools, approval, and a trajectory sink (1 drift, 18m)

  **Summary**: `run_volley` now takes per-seat tools, an approval handler for the builder, and an outside trajectory sink, and with none of them a run is exactly what it was, which a new test pins against the code as it stood before this step.

  1. Each seat can take its own tools, and the builder an approval handler, and they reach only that seat's calls.
  2. With a sink, the run streams through `run.stream` into both the file and the sink, and the file skips only the model chunks.
  3. The "changes nothing" test pins today's generate options and file event kinds exactly, and it passed against the old source first.
  4. A `claude_cli` seat takes none of the injected deps, since it brings its own tools.
  5. One stray outside the seam: the builder's `presets_dir` is now `builder_presets_dir`, and `test/unit/builder_prompt.test.ts` follows it.

  **Readout**: Step 2 - feat(orchestrator): inject seat tools, approval, and a trajectory sink

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    2 of 2 honored
  constraints  6 of 6 honored
  seam         strayed: 1 path outside the seam
               → test/unit/builder_prompt.test.ts
  diff         +504 -43 across 8 files
  spent        18 min · 1 turn · 11s gate · green first run
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Approve and land step 2. The baseline tests pass against the code before and after the change, so "leaving them out changes nothing" is shown rather than assumed, and the one stray is a two-line rename the gate forced.

  **1.** Each seat can take its own tools, and the builder an approval handler, and they reach only that seat's calls.

  `FlowDeps.engines` grew into `FlowDeps.seats` ([D2 (seat-deps)](#d2)): `{ builder: { engine, tools?, on_tool_approval? }, critic: { engine, tools? } }`, typed as `BuilderSeat` and `CriticSeat` in `src/flow.ts` as `Pick`s of the existing `BuilderDeps` and `CriticDeps`, so no parallel fields were added. `run_volley`'s deps gained `seats?`, the same shapes without the engine, and `deps.engine` still serves both seats. In `src/builder.ts` an injected set replaces `builder_tools(...)` and the handler lands as `on_tool_approval`; in `src/critic/run.ts` an injected set replaces `read_only_tools(...)` on the tool-bearing call only. The tool-less rung and the dry-run canary take no injected tools. The tests check by object identity that the builder's set and handler reach the builder's call, the critic's set reaches `critic_tools`, and the tool-less pass carries neither.

  **2.** With a sink, the run streams through `run.stream` into both the file and the sink, and the file skips only the model chunks.

  `execute_flow` in `src/orchestrator.ts` keeps today's single `run` into `trajectory.jsonl` when there's no sink. With a sink it calls `run.stream` with `tee_logger(without_model_chunks(file), sink)` and closes the handle's own event stream at once ([D1 (stream-inner-run)](#d1)). That matters because fascicle's `model_call` records `model_chunk` only when `ctx.streaming` is set. The file goes first in the tee on purpose. fascicle's `tee_logger` hands out the first sink's span ids as parents, so the file's parent links stay whole for the viewer. The sink sees parent ids it never issued, and I checked that this costs Zed nothing: `to_session_updates` counts a step's runs by the `id` on each `span_start` and never reads span ids. The test shows the sink gets the span starts (`build`, `builder`, `check`, `critic_tools`) and the builder's and critic's chunks in order. The file's event sequence equals the sink's minus `model_chunk`. The renderer still sees every builder chunk beside the forwarder.

  **3.** The "changes nothing" test pins today's generate options and file event kinds exactly, and it passed against the old source first.

  `test/integration/seat_deps.test.ts` compares each seat's whole generate options with `toStrictEqual`, on `claude_cli` and on `lmstudio`. That covers every key the call carried, the prompts, today's system prompts, the tool names, the loop knobs, and `on_chunk` being the renderer's own function, which shows no deps means no `run.stream`. It also pins the file trajectory's kinds (`flow_structure`, `run_end`, `span_end`, `span_start`) while both seats stream chunks. I captured those values with a throwaway probe on the old code (since deleted), then ran the three baseline tests with `src/` stashed back to HEAD, and they passed there too. `test/helpers/mock_engine.ts` gained a `chunks` field so a mock call streams through `on_chunk` as a provider would.

  **4.** A `claude_cli` seat takes none of the injected deps, since it brings its own tools.

  fascicle's `claude_cli` adapter ignores `on_tool_approval`, with an `option_ignored` event, and can refuse executable tools, so injected tools and the handler apply only on the tool-loop branch, where volley supplies tools today. That keeps a `claude_cli` critic under acp on the CLI's own reads, as [D20 (cli-critic-allowed)](#d20) expects. A test injects both seats' deps into a `claude_cli` run and gets today's options unchanged.

  **5.** One stray outside the seam: the builder's `presets_dir` is now `builder_presets_dir`, and `test/unit/builder_prompt.test.ts` follows it.

  The new test is the first file to import from both `src/builder.ts` and `src/critic/prompt.ts`, and fallow then flagged the `presets_dir` both modules export as a duplicate export, failing the dead slot. A dynamic import didn't clear it. The choices were a rename, a fallow suppression (the codebase has none), or a weaker test. I renamed the builder's, since `src/builder.ts` is in the seam, and the only file outside it is that unit test's import and one call. The critic's `presets_dir` keeps its name, and the `cli.ts` comment that mentions it still holds.

- 2026-10-17 — step 3 checkpointed · 562498bda — feat(state): add --state-dir to keep run state out of the workspace (1 drift, 13m)

  **Summary**: `--state-dir <root>` (or `state_dir` in a config file) now keeps each run's state at `<root>/<run_id>/`. Without it, every path is today's `.volley/`, rotation included. `volley resume <id> --state-dir <root>` finds and finishes such a run, and a matrix seat is read back from the root while `.volley-matrix/` stays in the workspace.

  1. One path rule, `run_state_dir`, now decides where every state file goes
  2. The critic's prior-state line is filled in, or dropped when state is outside the build root
  3. resume takes `--state-dir`, and the root you name wins over the recorded one
  4. Tests: spawned CLI runs against the OpenRouter stand-ins, plus a mutation check
  5. Four test files outside the seam needed small mechanical edits

  **Readout**: Step 3 - feat(state): add --state-dir to keep run state out of the workspace

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    4 of 4 honored
  constraints  6 of 6 honored
  seam         strayed: 4 paths outside the seam
               - test/helpers/harness.ts
               - test/integration/cli.test.ts
               - test/unit/config.test.ts
               - test/unit/critic_fallback.test.ts
  diff         +582 -97 across 19 files
  spent        13 min · 1 turn · 10s gate · green first run
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Approve and land step 3. The done-when is met with CLI-level evidence, and the `--worktree` prompt change is the only behavior change that D6 (critic-state-note) didn't spell out word for word.

  **1.** One path rule, `run_state_dir`, now decides where every state file goes

  `src/workspace.ts` swaps `volley_path(workspace, …)` for `run_state_dir`, `state_path`, and `iteration_dir`. Each takes a `StateLocation`, which is `{ workspace, state_dir, run_id }` (a `ResolvedConfig` fits it as-is). The rule is `<state_dir>/<run_id>/` when a root is set, else `<workspace>/.volley/`. `initialize_workspace` became `initialize_run_state` and rotates `<dir>` to `<dir>.bak.<stamp>`. For the default, that is exactly today's `.volley.bak.<stamp>`. Under a root, it only fires when a `--run-id` is reused, so two runs never share a directory. The orchestrator, iteration archive, resume, summary, and matrix all call the rule now; none builds a `.volley` path of its own. `config.json` records the resolved `state_dir`, and resume restores it.

  **2.** The critic's prior-state line is filled in, or dropped when state is outside the build root

  Both harness presets now put that sentence on its own line, with a `{{iterations_dir}}` placeholder. `place_iterations_dir` in `src/critic/prompt.ts` takes the path of the run's `iterations/` relative to `build_root`:
  - inside the build root, the line names that path (`.volley/iterations/` by default, `runs/<id>/iterations/` for a root inside the workspace);
  - outside it, the line is dropped.

  Two side effects of doing this:
  - The default prompt is re-wrapped. Same words, but the sentence now starts on a new line.
  - Under `--worktree` with no `--state-dir`, the line now drops too. The build root there is the sibling `<ws>.worktree` checkout, which has no `.volley/`, so the old line pointed the critic at a path that wasn't there. This follows D6 (critic-state-note) as written, but it is a small CLI prompt change.

  **3.** resume takes `--state-dir`, and the root you name wins over the recorded one

  `load_resume_state` takes an optional root. The CLI resolves `--state-dir` against the cwd and also merges it into the resumed config, so a root that was moved still resumes where it now is. While there, the dupes slot flagged the resume command's hand-copied output-flag subset. That block now destructures `{ workspace, stateDir, ...output }`, which is safe because cac refuses any option the command doesn't declare. The "not found" error now names the state directory rather than the workspace.

  **4.** Tests: spawned CLI runs against the OpenRouter stand-ins, plus a mutation check

  `test/integration/state_dir.test.ts` covers:
  - **Rooted run:** a run under a root keeps all seven state files there, and leaves only `done.txt` in the workspace.
  - **Reused id:** a reused id rotates aside.
  - **No flag:** without the flag, `.volley/` holds everything and rotates.
  - **Config:** a relative root resolves against the cwd.
  - **Resume:** a spawned `volley resume … --state-dir` finishes an interrupted openrouter run at iteration 2. `--workspace` is left at its default, which points somewhere else.
  - **Matrix:** a spawned `volley matrix` whose seat gets a 400 is counted as a recovered `error`, not `broke`. That only happens if its summary was read back from the root.

  The mutation check: pointing that read-back at the workspace instead fails the test. The critic tests cover the filled line, the nested root, and the dropped line (root outside, and `--worktree`).

  **5.** Four test files outside the seam needed small mechanical edits

  - `test/helpers/harness.ts` gains `state_dir: null`.
  - `test/unit/config.test.ts` and `test/unit/critic_fallback.test.ts` follow the new helper signatures.
  - `test/integration/cli.test.ts` adds `--state-dir` to its help-order list.

  Two other things outside the seam:
  - I parked one tangent: a root inside the workspace would show up in the builder's change list and in `--git` checkpoints.
  - The renderer's verbose cut-off hint now names the real trajectory path. `matrix` shows a `<run id>` placeholder there, since each seat has its own id.
