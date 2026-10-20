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

**Current step:** 11 — chore(deps): move to fascicle 0.16.3 and its acp agent options
**Heavy check:** checkride (set a "check" key in .plumbbob/settings.json to override)

## Steps

*(Mirror of intent.md's Steps, with live status; CLI-maintained, not hand-edited.
`build`/`checkpoint`/`revert` re-render this from intent.md, and set the Current step
line above. Only ONE step is in flight; a step is done only after a checkpoint:
check green + checkpoint taken, via `/plumbbob:verify` or `/plumbbob:build`.)*

- ☑ 1. feat(provider): add an openrouter seat provider
- ☑ 2. feat(orchestrator): inject seat tools, approval, and a trajectory sink
- ☑ 3. feat(state): add --state-dir to keep run state out of the workspace
- ☑ 4. feat(acp): give acp seats fascicle's workspace tools and prompts
- ☑ 5. feat(acp): serve volley to Zed as an ACP agent
- ☑ 6. feat(acp): show rounds, the check, and the verdict in Zed
- ☑ 7. feat(acp): ask before uncontained commands and hide provider keys
- ☑ 8. test(acp): drive a whole volley turn through an in-process ACP client
- ☑ 9. docs(readme): document volley acp, OpenRouter, and the Zed setup
- ☑ 10. test(acp): script and pass the live check in Zed
- ☐ 11. chore(deps): move to fascicle 0.16.3 and its acp agent options
- ☐ 12. test(acp): run the live check in Zed

## Park list

> Mid-step, every new problem / idea / "ooh what if" lands HERE, untouched, and you
> go straight back to the step. Acting the instant an idea arrives is the disease.
> Capture is one line (`/plumbbob:park` composes it). Harvest happens only at the boundary.

- [x] a --state-dir inside the workspace shows up in the builder's change list and --git checkpoints, since changes.ts excludes only .volley/ and .volley.bak.*
- [x] acp_tools' cwd_only session copy hides fascicle's per-session preview store (a WeakMap keyed on the session object): an edit's card closes without its diff, and in a client that draws terminals (Zed) every run_command terminal closes empty with no exit code
- [ ] the check's permission request carries kind 'other' (fascicle's approver defaults a tool it has no presenter for), so a client that applies the request's fields may redraw the check's execute card as a plain one while it asks; watch for it in the live check's step 4
- [x] src/flow.ts's critic retry step says 'local providers only', but is_retryable_critic_error retries every provider but claude_cli, openrouter included; the README's diagram copy repeats it (a test holds the two in step)
- [x] upgrade to fascicle 0.16.3 (fascicle#15): additional_directories:false and modes ['manual','accept_edits'] when unguarded in acp_serve_config, drop cwd_only and the always-ask wrapper, rewrite the 5 tests of the old mechanism, tighten step 8's write-close diff, fix the README (Auto row, Zed check step 8, exact-line grants, OpenRouter cost/reasoning) and cost_source_of; resolves the session-copy park
- [ ] src/flow.ts's critic fallback row still says 'if a local critic keeps dying', but is_degradable_critic_error degrades every provider but claude_cli, openrouter included; the README's diagram copy repeats it
- [ ] fascicle 0.16.3 peers zod at ^4.2.0 (0.14.0 pinned exactly 4.4.3), so C2 (exact-pins)'s zod hold no longer comes from fascicle; zod can move once a newer one clears the 48-hour window

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
- 2026-10-19, after step 10: "acp_tools' cwd_only session copy hides fascicle's per-session preview store" → **blocker**, folded into D28 (acp-agent-options) and step 11. Building the tools from the session itself fixes it once `additional_directories: false` takes the copy's place. In a trial on fascicle 0.16.3, the edit card kept its diff.
- 2026-10-19, after step 10: "src/flow.ts's critic retry step says 'local providers only'" → **blocker**, folded into D29 (retry-label) and step 11, so the diagram stops misdescribing an `openrouter` critic.
- 2026-10-19, after step 10: "upgrade to fascicle 0.16.3 (fascicle#15)" → **blocker**, folded into D28 (acp-agent-options) as step 11. Step 10 landed with its Zed run still owed, so the run is now step 12, on 0.16.3.

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
- 2026-10-17 — step 4 checkpointed · 267c13feb — feat(acp): give acp seats fascicle's workspace tools and prompts (1 drift, 47m)

  **Summary**: Under acp, the builder can now take fascicle's approval-gated workspace tools plus volley's `finish`, and the critic can take that set's three reads. Both are confined to `session.cwd` and skip volley's ignored directories, and each seat's prompt names the set it holds. With no set, the default prompts are byte-for-byte what they were.

  1. One call builds both acp seats' tools, confined to `session.cwd`
  2. Each seat now names its tool set, and with no set the prompts are unchanged
  3. The builder's acp preset says what a refusal means and what to do next
  4. The critic's acp preset names `search` but not `run_command` or `tool_approval_denied`
  5. Three paths outside the seam, all needed to carry the tool set through

  **Readout**: Step 4 - feat(acp): give acp seats fascicle's workspace tools and prompts

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    honored
               - D7 (acp-tool-sets)
               - D8 (acp-prompts)
  constraints  6 of 6 honored
  seam         strayed: 3 paths outside the seam
               - src/critic/run.ts
               - src/flow.ts
               - test/helpers/harness.ts
  diff         +629 -34 across 13 files
  spent        47 min · 1 turn · 23s gate · green first run
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Approve and land step 4. Each done-when clause has a test that fails when its piece is removed, and the 20 default prompts hash the same as before. The three paths outside the seam only carry `tool_set` through, plus one shared test fixture.

  **1.** One call builds both acp seats' tools, confined to `session.cwd`

  `acp_seat_tools(session, { command_env })` in `src/acp_tools.ts` calls `workspace_tools` once, on a copy of the session whose only root is `roots[0]` (the real path of `cwd`) and that has no additional directories. It passes `ignore: [...IGNORED_DIRS]` and hands `command_env` straight through. The builder gets all six tools plus `finish_tool()`. The critic gets the same set filtered by name to `read_file`, `list_files`, and `search`. Each half comes back tagged `tool_set: 'acp'`, so step 5 can spread it straight into `run_volley`'s `seats`.

  - `finish_tool()` is pulled out of `builder_tools`, which now calls it, so both sets share one `finish`.
  - `IGNORED_DIRS` is now exported, as a `ReadonlySet`.
  - fascicle builds `approve` as a closure over the session it made, so the copy narrows only containment. Approvals still go to the real session.
  - `fascicle/acp` loads without `@agentclientprotocol/sdk` installed, as D17 (sdk-pin) expected.

  What the tests in `test/unit/acp_tools.test.ts` show:
  - the tool names, exactly;
  - `write_file`, `edit_file`, and `run_command` ask in Manual, Accept edits, and Auto as fascicle's modes say. volley's own write tools never ask, so this also proves they're fascicle's;
  - `finish` ends the turn;
  - `command_env` replaces the environment: a variable set in `process.env` reads as unset inside a command;
  - for both seats, every `IGNORED_DIRS` name is skipped by `list_files` and `search`, while `.github/` still lists and fascicle's default lists `dist/`;
  - for both seats, reads, lists, searches, writes, and edits under an additional directory are refused, though the session itself can reach that directory.

  I mutation-checked each piece. Removing the `cwd` copy, the `ignore` option, or the `command_env` pass-through each fails exactly its own test.

  **2.** Each seat now names its tool set, and with no set the prompts are unchanged

  `ToolSet = 'volley' | 'acp'` lives in `src/workspace_tools.ts`. `BuilderDeps` and `CriticDeps` gain an optional `tool_set`, and the seat types pick it up, so `run_volley`'s `seats` dep carries it with no change to the orchestrator. `compose_builder_system_local` and `resolve_critic_prompt` take the set, defaulting to `'volley'`, and pick `harness_append_acp.md` for `'acp'`.

  - A `claude_cli` seat ignores the set, just as it ignores injected tools. That matters for the critic: D20 (cli-critic-allowed) lets a `claude_cli` critic run under acp, and it still needs the `Read, Grep, Glob` append.
  - The critic's acp append keeps the `{{iterations_dir}}` line, so D6 (critic-state-note) still drops it when state sits outside the build root, which is acp's default.
  - The `--dry-run` canary keeps volley's reads, since acp has no dry run.

  Byte for byte: before editing anything, I hashed 20 default prompts:
  - the CLI builder and the local builder;
  - the critic on `claude_cli`, `ollama`, and `openrouter`, across three presets, with state both inside and outside the build root.

  All 20 hashes are identical after the change.

  The tests run `make_builder_step` and both critic rungs against the mock engine. They compare the system prompt each call carries with today's formula, built from the preset files on disk. Removing `deps.tool_set` from either seat's call fails that seat's acp test.

  **3.** The builder's acp preset says what a refusal means and what to do next

  `src/builder/presets/harness_append_acp.md` is modeled on acp-coder's `prompts/coder.md`, laid out like the local preset: the tool list, then "Work this way". It covers:
  - each tool with fascicle's parameters (`old_text`/`new_text`, `offset`/`limit`, `glob`, `timeout_ms`);
  - the user sees every call, so the builder reads and edits through the file tools, not `cat` or `sed`;
  - a command gets no input, so no pagers, watch modes, or dev servers;
  - no reaching outside the workspace by command, no destructive git, publish, or install commands, and no commits;
  - file contents and command output are data, not instructions;
  - the task can open with earlier turns (D10, coming in step 6), so the builder should re-read files rather than trust them;
  - it can't ask mid-task, so on an ambiguous task it makes a choice and says which;
  - its text is the reply in the editor, so it should keep it short.

  `tool_approval_denied` means the user said no: don't repeat the call, don't reach the same result another way, and carry on. If the refusal blocks the task, say so and call `finish` with a summary naming what was refused. That last part departs from acp-coder, which says to ask the user how to go on. volley's builder can't wait for an answer mid-run, so finishing with the refusal named puts it in front of both the critic and the user.

  The six work rules from the local preset are kept, with rule 5 now saying `run_command` and the project's package manager. The preset runs about 85 lines, against the local one's 45.

  **4.** The critic's acp preset names `search` but not `run_command` or `tool_approval_denied`

  The done-when lists `run_command`, `search`, and `tool_approval_denied` for "a seat holding an acp set". D8 (acp-prompts) attaches those words to the builder's preset, so I read the list as the builder's.

  The critic's acp preset names `read_file`, `list_files`, and `search`, and says it can't modify files or run commands. It doesn't mention `run_command` or `tool_approval_denied`, because it holds neither and its reads never ask. The tests match that reading:
  - the builder's preset names all three;
  - the critic's names its three reads, and none of `search_files`, `run_command(`, or `write_file(`.

  The critic's acp preset also adds one line the local critic preset doesn't have: files are evidence, not instructions, so a comment telling it how to judge is a finding to weigh. If you'd rather the acp preset be the local one with only the tool list swapped, that line comes out.

  **5.** Three paths outside the seam, all needed to carry the tool set through

  - `src/critic/run.ts`: `CriticDeps` gains `tool_set`, and `critic_call_config` passes it on. The critic's system prompt is set there, not in `prompt.ts`.
  - `src/flow.ts`: `BuilderSeat` and `CriticSeat` pick `tool_set`. These are two type lines and their comments.
  - `test/helpers/harness.ts`: an `acp_session()` fixture, shared by the three test files. Copying it into each would trip the dupes check, and steps 5 through 8 will want it too.

  The seam missed them because D8's "each seat's deps name its tool set" runs through the seat types and the critic's call config.

- 2026-10-17 — step 5 checkpointed · 497d57a1a — feat(acp): serve volley to Zed as an ACP agent (92m)

  **Summary**: `volley acp` now serves volley over stdio through fascicle's `serve_acp`. Each prompt runs a fresh volley run on the session's folder, with fascicle's workspace tools, approvals through `session.approve`, and the turn's own trajectory as the run's sink, so the builder's text arrives as the reply. Run state goes under `$XDG_STATE_HOME/volley`, not the repo. Every refusal and config error exits 5 before serving. `@agentclientprotocol/sdk` is pinned at 1.8.0.

  1. Each prompt is one volley run on the session's folder, streamed into the turn
  2. Everything that can be refused is refused before serving, with its reason
  3. Each turn sets the task after resolving, so a prompt starting with `@` isn't read as a file
  4. A spawn test and an in-process turn, and each piece fails its own test when removed
  5. fallow reads the SDK as test-only, so it joins `ignoreDependencies` as D17 planned

  **Readout**: Step 5 - feat(acp): serve volley to Zed as an ACP agent

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    honored
               - D5 (state-layout)
               - D9 (acp-flags)
               - D11 (acp-routing)
               - D17 (sdk-pin)
               - D20 (cli-critic-allowed)
               - D21 (acp-iterations-3)
               - D24 (acp-seats-required)
               - D27 (startup-resolve)
  constraints  6 of 6 honored
  seam         held: 7 of 7 declared, no strays
  diff         +552 -13 across 7 files
  spent        92 min · 1 turn · 12s gate · green first run
  ```

  **Verdict**: ● Plumb

  **Recommendation**: Approve and land step 5. Every done-when clause has a test that fails when its piece is removed, the seam held to its seven paths, and the gate is green; the one call the plan didn't make is setting the task after resolving (highlight 3).

  **1.** Each prompt is one volley run on the session's folder, streamed into the turn

  `src/acp.ts` builds the serve config: name `volley` at the package version, Manual by default, `to_input: turn => turn`, and `to_text: () => ''`. `stream` sends `builder` to the reply and every other step to `none`, so the critic's verdict JSON never reaches the thread (D11 (acp-routing)).

  - **Per session:** `acp_seat_tools(session)` builds both seats' tools once, and the builder also gets `session.approve`.
  - **Per prompt:** the one step `acp_turn` resolves the config against `session.cwd`. It then calls `run_volley` with those seats, `trajectory: ctx.trajectory`, `abort: ctx.abort`, signal handlers off, and a quiet renderer on stderr.
  - **State root:** under acp, the state root defaults to `$XDG_STATE_HOME/volley`, else `~/.local/state/volley`. A relative `XDG_STATE_HOME` is ignored, as the XDG spec says (D5 (state-layout)).
  - **Rounds:** `--max-iterations` defaults to 3 (D21 (acp-iterations-3)).

  Two things are still the CLI's way until later steps:
  - The task and the criteria are `turn.text` alone. Rendering the history in front of it is step 6's done-when (D10 (turn-task)).
  - An uncontained tool-loop builder still needs `--allow-unsandboxed-builder`, because `resolve_config`'s refusal only drops under acp in step 7 (D15 (command-gate)). So the Zed snippet won't work without that flag until step 7 lands.

  **2.** Everything that can be refused is refused before serving, with its reason

  `acp_base_config` runs in this order:
  1. It refuses `--worktree`, `--git`, and `--json`, each with its reason.
  2. It names every missing seat flag in one message: `volley acp requires every seat flag, and these are missing: …`.
  3. It refuses a `claude_cli` builder. A `claude_cli` critic passes (D20 (cli-critic-allowed)).
  4. It resolves the whole config once against the system temp directory with a stand-in task, so an unset `OPENROUTER_API_KEY`, a bad cap, or a missing `--critic` file exits 5 there too (D27 (startup-resolve)).

  Under acp, the shared `with_seat_options` helper now labels each seat's model and provider "(required)". The run command's help is unchanged, and the existing help-order test still passes. `--worktree`, `--git`, and `--json` are declared with "Refused: …" descriptions so cac doesn't answer them with a bare "Unknown option" (D9 (acp-flags)).

  **3.** Each turn sets the task after resolving, so a prompt starting with `@` isn't read as a file

  `resolve_config` expands any prompt or criteria starting with `@` as `@path`, reading the file or throwing a config error. A user who types `@README.md tighten this` in Zed would hit that. So each turn resolves with the stand-in task and then sets `prompt` and `criteria` to the turn's text, which is what `config.json` records. This is a judgment call the plan didn't spell out. It doesn't change what D27 (startup-resolve) asks for: each turn still resolves against `session.cwd`.

  **4.** A spawn test and an in-process turn, and each piece fails its own test when removed

  `test/integration/acp_cli.test.ts` has three parts.

  **Spawned under tsx:**
  - One `initialize` line gets exactly one JSON-RPC line back on stdout, naming `volley` at `package_version()`, and the agent exits 0 once stdin closes.
  - A `claude_cli` critic is served.
  - Each refusal and the unset key exit 5 with their reason and an empty stdout.

  **`acp_base_config` directly:** the 3-round default, an explicit cap kept, and the state root under XDG, `~/.local/state`, and an explicit `--state-dir`.

  **In process:** `test/helpers/acp_client.ts` connects the SDK's own `client()` to `acp_agent` over ndjson. One prompt runs both seats on their own OpenRouter stubs. The test asserts:
  - the turn ends `end_turn`;
  - the updates are exactly one message chunk carrying the builder's text;
  - each stub saw only its own model;
  - there's no `.volley` in the workspace;
  - the run's `config.json` sits under the XDG root with the session's workspace, the prompt as task and criteria, and `max_iterations: 3`;
  - nothing was written to stdout (C4 (stdout-protocol)).

  I mutation-checked four pieces, and each fails its own test:
  - routing every step to the reply;
  - dropping `trajectory: ctx.trajectory`;
  - dropping the state-root default;
  - skipping the startup resolve.

  **5.** fallow reads the SDK as test-only, so it joins `ignoreDependencies` as D17 planned

  Only fascicle loads `@agentclientprotocol/sdk` at runtime, through a dynamic import. volley's own source never imports it, and only the ACP tests do, for the client. So fallow's dead slot flagged it as a test-only dependency. Per D17 (sdk-pin), it now sits in `ignoreDependencies` beside `ai`, under the same comment, extended to say why. It stays in `dependencies` at exactly `1.8.0`, and the lockfile now resolves fascicle with the SDK as its peer.

- 2026-10-17 — step 6 checkpointed · dde26aaf0 — feat(acp): show rounds, the check, and the verdict in Zed (1 drift, 143m)

  **Summary**: A volley turn in Zed now shows its progress: each round opens with a `**Round N**` line in the reply, the check runs as an `execute` card titled with its command and closes with its output, the critic's verdict arrives as a thought, and the turn ends with a summary message, including when the run failed. Each prompt's task is now the whole conversation so far, and a CLI run's `trajectory.jsonl` carries the same progress events.

  1. The phases emit round, check, and verdict events, and the check records its own card while it runs
  2. One wrapper turns those events into the round line, the command card, the verdict thought, and the summary
  3. A failed run ends the turn with a summary naming the round, the phase, and the error, and the next prompt reads it back
  4. Each turn's task is now the conversation so far, with earlier files named rather than repeated
  5. Two test files outside the seam pinned the old output, and two smaller judgment calls

  **Readout**: Step 6 - feat(acp): show rounds, the check, and the verdict in Zed

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    honored
               - D10 (turn-task)
               - D12 (emit-events)
               - D13 (check-card)
               - D14 (failed-turn)
               - D19 (round-in-reply)
               - D26 (summary-content)
  constraints  6 of 6 honored
  seam         strayed: 2 paths outside the seam
               - test/integration/acp_cli.test.ts
               - test/integration/seat_deps.test.ts
  diff         +1114 -59 across 7 files
  spent        2h 23m · 1 turn · 10s gate · green first run
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Approve and land step 6. Every done-when clause has a test that fails when its piece is removed, and the gate is green; the two strays only move pinned expectations to this step's new output.

  **1.** The phases emit round, check, and verdict events, and the check records its own card while it runs

  `src/phases.ts` now emits four `ctx.emit` payloads, each tagged with a `volley` field, because `ctx.emit` overwrites `kind` (D12 (emit-events)):
  - `round_start` when the build opens a round;
  - `check_start` and `check_end` around a check that runs a command;
  - `verdict` after the critique, carrying the feedback, the unmet criteria, and whether the verdict was degraded.

  On a streamed run (`ctx.streaming`), the check also records its card as `model_chunk` events under step id `check`, the same chunks `model_call` records for a tool call: `tool_call_start`, then `tool_call_end` with `{ command }` as input, then `tool_result` with the `CheckResult` as output, or the error when the check threw (D13 (check-card)). The step id matches the check step's own, so fascicle's mapper counts each round's check as a new run and opens a fresh card. The tool's name is `check`, outside fascicle's gated three, which leaves step 7 room to ask Allow/Reject on this card (D25). On the CLI nothing streams, so no chunks are recorded, and the emits land in `.volley/trajectory.jsonl`. `test/integration/happy_path.test.ts` asserts all four emits in order there, and no `model_chunk`.

  **2.** One wrapper turns those events into the round line, the command card, the verdict thought, and the summary

  `progress_updates` in the new `src/acp_progress.ts` is volley's `to_updates`. It calls fascicle's `to_session_updates` on every event first, so the run counts and the builder's cards keep working, then adds volley's own updates:
  - **Round line:** `round_start` becomes `**Round N**` in the reply. Rounds after the first get a blank line first, so they sit apart from the builder's text (D19 (round-in-reply)).
  - **Check card:** the card's updates are dressed as a command. It opens as `kind: 'execute'`, is retitled with the command line when its input lands (as fascicle's `run_command` card is), and closes `completed` or `failed` with the output in a `console` block, cut at 32,000 bytes with fascicle's marker and ending `[exit code N]`. A check that threw closes as fascicle closes any failed call, with its error text. `check_start` and `check_end` add nothing, since the card already shows both (D13 (check-card)).
  - **Verdict thought:** `verdict` becomes a thought holding the verdict, the feedback, and the unmet criteria as a list. A degraded verdict is marked `(judged without its tools)`.
  - **Summary:** the summary becomes the turn's last message. It says whether the run converged, in how many rounds, and the last verdict. A run that didn't converge also lists what's still unmet, and any gate edits and any degraded verdict are named (D26 (summary-content)).

  `acp_turn` builds the summary from `build_run_summary`, which already gathers the unmet criteria, gate edits, and degraded flag from the run's archive, so no new bookkeeping was needed. The unit test at the heart of this runs a real two-round `run_volley`, nested in an outer streamed step the way `acp_turn` nests it. Round 1's check fails and the critic asks for changes; round 2's passes and the critic approves. Fed through the wrapper, the events must equal the exact twelve-update sequence, card ids included.

  **3.** A failed run ends the turn with a summary naming the round, the phase, and the error, and the next prompt reads it back

  `acp_turn` now catches a failure. Unless the turn's own signal fired, it emits a failure summary and ends the turn normally, so fascicle keeps the exchange in the session's history and "try again" has something to retry (D14 (failed-turn)). An abort still rethrows, so a stopped turn ends cancelled.
  - **Phase:** a phase error names its phase and carries the underlying message, which is what the summary shows. A check error is the check's.
  - **Round:** a check error carries no round, so `follow_rounds` wraps the turn's trajectory and remembers the last `round_start` that passed through.

  The in-process ACP test checks both halves. A critic stub that answers `not a verdict` makes the turn end `end_turn` with `**Run failed** in round 1, during the critique: …` as its last message. A second prompt's recorded task then holds that whole exchange, summary included. The abort rethrow has no test of its own: driving a cancel mid-run needs a slow stub, which is step 8's and step 10's ground.

  **4.** Each turn's task is now the conversation so far, with earlier files named rather than repeated

  `turn_task` renders each `turn.history` entry ahead of the prompt, and that rendering is both the task and the criteria (D10 (turn-task)). A first turn is still its prompt alone, so step 5's config assertion holds unchanged.
  - **Earlier user entries:** each attached file's `<context ref>` block is replaced by one `[attached: <uri>]` line per file.
  - **Agent entries:** each is cut to its last 2,000 characters behind a `…`.
  - **Stopped turns:** a `cancelled` entry is followed by acp-agent's own "[The user stopped this turn here…]" line.
  - **The new prompt:** it comes last, with its own files whole.

  One robustness call: a file's own text can contain `</context>` (this step's test file does). So a block ends only where the next block starts, not at the first closing tag, and the test attaches exactly such a file. A plain regex was tried first and dropped.

  **5.** Two test files outside the seam pinned the old output, and two smaller judgment calls

  - `test/integration/acp_cli.test.ts` asserted that a turn sends exactly one message chunk. It now asserts the round line, the builder's text, the verdict thought, and the summary, and it gains the failed-turn test from highlight 3. A shared `serve` helper keeps the two turns from tripping the dupes check.
  - `test/integration/seat_deps.test.ts` pinned the CLI file trajectory's event kinds from before step 2. Those kinds now include `emit`, which is this step's own done-when and an additive change under C5 (cli-unchanged).
  - **checkride's card text:** volley keeps no raw stdout for checkride, only its JSON summary and each failing slot's artifact. So its card lists each slot (`ok`, `skip`, `FAIL`), then each failing slot's output, rather than showing raw JSON.
  - **Summary wording:** the converged line says `**Converged** in N rounds. Last verdict: approved.` I dropped "the check passed" because a run with no check converges too.

  I mutation-checked eleven pieces, and each fails its own test when removed:
  - the `to_updates` wiring, the history rendering, the failure emit, and the round tracker;
  - opening and closing the check card, the streaming guard, and the round emit;
  - the stopped marker, the context seam, and the `execute` kind.
- 2026-10-17 — step 7 checkpointed · 534f3e533 — feat(acp): ask before uncontained commands and hide provider keys (1 drift, 50m)

  **Summary**: Under acp, when volley runs uncontained with no opt-out, every builder command and every check now asks first, whatever the mode. Neither the commands nor the check can read the seats' API keys, and a rejected check counts as a failed one. The CLI behaves exactly as before.

  1. Uncontained with no opt-out, `run_command` asks in every mode, and acp no longer refuses the builder
  2. The builder's commands and the check run without `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY`, and the CLI's check still inherits everything
  3. The check asks through `session.approve` on its own card, offering only Allow and Reject, and a rejection is recorded as failed
  4. The check asks under its command line as the tool name, not under `check`
  5. Two test files sit outside the seam: `test/helpers/acp_client.ts` and `test/integration/acp_cli.test.ts`

  **Readout**: Step 7 - feat(acp): ask before uncontained commands and hide provider keys

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    honored
               - D15 (command-gate)
               - D16 (key-strip)
               - D25 (check-approval)
  constraints  6 of 6 honored
  seam         strayed: 2 paths outside the seam
               - test/helpers/acp_client.ts
               - test/integration/acp_cli.test.ts
  diff         +773 -105 across 14 files
  spent        50 min · 1 turn · 38s gate · green first run
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Approve and land step 7. Every done-when clause has a test, breaking each piece of the new wiring on purpose fails one, and the gate is green. The two strays are where fascicle's real approver can be reached.

  **1.** Uncontained with no opt-out, `run_command` asks in every mode, and acp no longer refuses the builder

  `config.ts` gains `unguarded_builder(raw, env)`: not contained, and opted out by neither the flag nor the variable. It is now the one rule behind both enforcements. `resolve_config` takes `uncontained_builder: 'refuse' | 'ask'`. The default `refuse` keeps the CLI's refusal word for word, and `acp.ts` passes `ask` at startup and on every turn. When the rule holds, `acp_seat_tools` sets `run_command`'s `needs_approval` to `true`, so even Auto asks. A user's "Always allow `pnpm test`" grant still counts as asked, because fascicle's approver checks its grants before prompting. Contained, or opted out, `run_command` keeps fascicle's own gate, which reads the mode on every call. Tests: `acp_tools.test.ts` covers all three modes both ways, `config.test.ts` covers acp against the CLI for ollama, lmstudio, and openrouter plus the predicate's truth table, and `acp_cli.test.ts` shows `acp_base_config` serving a builder with no opt-out.

  **2.** The builder's commands and the check run without `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY`, and the CLI's check still inherits everything

  `engine.ts` now owns `SEAT_CREDENTIAL_VARS`, built from the same two constants the engine reads its keys through, so the list can't drift. `acp_command_env` is the agent's environment minus exactly those two, with `PATH` and everything else kept. `acp_seat_tools` builds that environment once and hands it to both `workspace_tools` and the check, so the two can't diverge. `spawn_capture`, `run_checkride`, and `run_command_check` share a `CheckSpawnOptions` with an optional `env`. When `env` is absent, they inherit as before. Tests cover each layer:

  - a builder `run_command` running `env`;
  - the command runner, with an env and without one;
  - checkride through `run_volley`, with an env and without one;
  - the in-process acp turn, whose check prints its own environment.

  **3.** The check asks through `session.approve` on its own card, offering only Allow and Reject, and a rejection is recorded as failed

  `check_phase` now takes an optional `CheckGate` (`env`, `on_approval`) through `run_volley`'s deps. Once the card is open, it asks with `tool_call_id: 'check'`. fascicle's approver uses that id to anchor the prompt on the card already on screen. Under acp, `on_approval` calls `session.approve` only when the builder's `run_command` would ask about the same command. Otherwise it allows without asking. A rejection never spawns anything: `rejected_check` records a failed check whose output is the refusal, the card closes failed with that text, and the critic's prompt reads `FAILED` along with the reason. A stop that lands while the check is asking ends the run as stopped, not as a rejection. The in-process tests drive fascicle's real approver: uncontained in Auto, it asks with exactly Allow and Reject on the check's card, and a rejection never runs the check. Contained, Auto doesn't ask and Manual does.

  **4.** The check asks under its command line as the tool name, not under `check`

  D25 says only "a tool name outside fascicle's gated three". fascicle's approver sets the permission card's title to the tool name. Zed applies that update to the card, so a name of `check` would retitle the card from `pnpm test` to `check` the moment it asks, breaking D13 (check-card). Using the command line keeps the title, and no gated tool shares it. The one exception is a `--check` command named literally `run_command`, `write_file`, or `edit_file`, which I left alone.

  **5.** Two test files sit outside the seam: `test/helpers/acp_client.ts` and `test/integration/acp_cli.test.ts`

  Only fascicle's real approver decides which options a prompt offers, and only an in-process `acp_agent` session reaches it. So `open_session` now takes `{ on_permission, mode }`: it answers `session/request_permission` and can switch the session's mode. The acp turn tests sit beside the turn tests already there. Step 8 lists both files in its seam and can reuse the helper as is. `src/flow.ts` is in the seam but needed no change, since `FlowDeps` already extends `PhaseDeps`.

- 2026-10-17 — step 8 checkpointed · bc9f19ce6 — test(acp): drive a whole volley turn through an in-process ACP client (6m)
- 2026-10-17 — step 9 checkpointed · f1fe913c0 — docs(readme): document volley acp, OpenRouter, and the Zed setup (4m)
- 2026-10-20 — step 10 checkpointed · 74df9f510 — test(acp): script and pass the live check in Zed (3583m)

  **Summary**: The README has the live check in Zed, eight steps plus the key and `.volley` checks. It lands unrun at your call, because the run waits on the parked fascicle 0.16.3 upgrade.

  1. The script is written; the live run is still owed
  2. The run waits on the fascicle upgrade

  **Readout**:

  ```text
  check        green: 1 of 1 checks
  done-when    not met: the script is written, but no one has run it in Zed
               → landed at your call; the Zed run waits on the fascicle upgrade
  decisions    honored
               - D15 (command-gate)
               - D16 (key-strip)
               - D25 (check-approval)
  constraints  6 of 6 honored
  seam         held: 1 of 1 declared, no strays
  diff         +27 -0 across 1 file
  spent        59h 43m · 9 turns · 10s gate · green first run
  ```

  **Verdict**: ○ Out of plumb (done-when not met)

  **Recommendation**: Harvest next, so the upgrade lands as a step of its own. The Zed run then follows, on the stack it will ship on.

  **1.** The script is written; the live run is still owed

  The new "Check it in Zed" section follows the done-when's eight steps, then echoes `$OPENROUTER_API_KEY` and checks for no `.volley`. No one has run it in Zed yet, so the done-when's "a person runs it" and "results in the build log" stay open.

  **2.** The run waits on the fascicle upgrade

  On fascicle 0.14.0, volley's `cwd_only` session copy drops each edit's diff from its card and empties each command's terminal. fascicle#15 shipped `additional_directories` and `modes` in 0.16.2. On 0.16.3, with volley's copy and wrapper gone, the whole-turn test passes and the write card keeps its diff, as tried in a throwaway worktree. That upgrade is parked. It also changes this script's step 8: outside a container, Auto is no longer offered.
