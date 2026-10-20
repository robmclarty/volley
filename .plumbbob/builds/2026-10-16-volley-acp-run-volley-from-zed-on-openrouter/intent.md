<!--
intent.md: your canonical intent, written in DESIGN before any code. This is the
head; the chat is the hand. When the model floods you, read this, not your memory.

Size to the work: a small change fills Frame + a couple of Decisions and deletes
the rest; a medium feature fills it all. Opinionated where decided, explicit where
open. If the implementor (you-later, or the LLM) has to guess, the doc failed.

One rule runs through the whole doc: compress what's settled; expand what's pending.
Decisions and Constraints stay one line each; they re-inject into every build step,
so their tokens recur. Open questions expand into plain-then-lean prose; a human
reads them once, to decide, and that legibility buys back a chat round-trip.
-->

# volley acp: run volley from Zed on OpenRouter

**Phase:** frame
**Size:** large
**Scope:** acp

*Source: `research/specs/volley-spec-acp.md` (revised 2026-10-16 against fascicle 0.14.0), and the planning brief of 2026-10-16; both preserved under [Source](#source). The fascicle facts below were checked against `~/Projects/fascicle/code/fascicle` at v0.14.0: `docs/acp.md`, `src/acp/*.ts`, `src/core/runner.ts`, `src/core/streaming.ts`, `src/model_call.ts`, and `examples/acp-coder/`.*

## Frame

- **Problem:** volley runs only from a terminal, and its seats need either the Claude Code CLI or a local model server. Zed's agent panel can't drive it. Served under ACP as volley stands today, it would go wrong in three ways:
  - its own `write_file`, `edit_file`, `bash`, and `fetch` set no `needs_approval`, so they would act unasked in every mode;
  - its inner `run` reaches no outer trajectory, so Zed would see none of the builder's work;
  - every prompt would rotate `.volley/` inside the user's repo.
- **Smallest thing that solves it:**
  - An `openrouter` seat provider, usable from the plain CLI first, so one API key runs both seats, Claude included.
  - A `volley acp` command that serves volley through fascicle 0.14.0's `serve_acp`. Each prompt runs `run_volley` on `session.cwd`:
    - the builder gets fascicle's workspace tools and `session.approve`, and the critic gets the three reads;
    - the turn's stream logger is tee'd into the run's trajectory, so Zed sees the builder's text, cards, and approval prompts;
    - volley's phases emit round, check, verdict, and summary events, which a `to_updates` wrapper renders.
  - Run state moves out of the workspace (`--state-dir`).
  - Uncontained, every builder command and every check asks first, and neither sees the provider keys.
- **Done looks like** (the spec's done-when):
  - In Zed, `volley acp` on a scratch repo, in Manual:
    - streams the builder's work as the reply;
    - asks before each edit, with its diff, and before each command;
    - asks before the check, as before any command, and runs it as a command card;
    - shows the critic's verdict as a thought;
    - ends the turn with the summary when the run converges or reaches `--max-iterations`.
  - Pressing stop mid-run ends the turn as cancelled. It kills a running command or check with its whole process group and leaves no stray processes.
  - In Auto, uncontained, a command still asks.
  - Neither the builder's commands nor the check can read `OPENROUTER_API_KEY`.
  - Nothing of volley's own state appears in the repo.
  - `volley --builder-provider openrouter --critic-provider openrouter ...` works from the CLI.
  - An ACP test drives `volley acp`'s flow through `acp_agent` and the SDK's in-process client, with a real engine against a stub model server. It asserts:
    - the builder's cards;
    - one approval round trip, allowed and rejected;
    - the check card;
    - the verdict thought;
    - the summary.
  - The README documents `volley acp`, the OpenRouter settings, and the Zed snippet.
  - `pnpm check` is green at every step.
- **Explicitly NOT doing:**
  - MCP servers from the client, ACP auth methods, and `session/load`. fascicle ignores or doesn't offer each of them.
  - The `fetch` tool under ACP, which would reach the network unasked. It can come back later behind a `needs_approval` of its own.
  - `--worktree` under ACP.
  - OpenRouter cost and reasoning, which are fascicle gaps (fascicle's `research/openrouter-cost-spec.md` and `research/openrouter-reasoning-spec.md`). `--max-iterations` is the guard, and `VOLLEY_PRICING_PATH` can supply prices.
  - Deriving the sandbox allowlist from seat endpoints. A contained OpenRouter seat needs `openrouter.ai` let through the operator's `DOCKER-USER` rules, which the README says and volley doesn't install.
  - The native Ollama transport.
  - V6's atomic `.volley/` writes, parked for a change of their own ([D22 (no-atomic-writes)](#d22)).
  - Pruning old run directories under the acp state root. The README says where the root is and that it's safe to delete ([Q10 (trajectory-growth)](#q10)).
  - A release. The build lands on main; `/version` and the push stay the human's.

## Architecture sketch

```
Zed ──ACP over stdio──> volley acp                         src/cli.ts → src/acp.ts
  serve_acp({ name: 'volley', version, default_mode: 'manual', to_input: turn => turn,
              stream, to_updates, to_text: () => '', flow })
  flow(session) = step('acp_turn', (turn, ctx) => …)        built once per session/new
  │  config = the acp flags + { prompt and criteria: history + turn.text,      [D10]
  │                             workspace: session.cwd, state root }           [D5]
  │  run_volley(config, {
  │    renderer: quiet, on stderr        abort: ctx.abort      install_signal_handlers: false
  │    trajectory: ctx.trajectory                         ← the bridge           [D1]
  │    seats: builder { tools: workspace_tools(session, …) + finish,           [D2] [D7]
  │                     on_tool_approval: session.approve }
  │           critic  { tools: read_file, list_files, search } })
  │    └─ run.stream(volley's flow, { trajectory: tee_logger(file logger minus chunks, ctx.trajectory) })
  │         builder's model_chunk  → reply text, tool cards, approval prompts
  │         critic_* model_chunk   → text to none, reasoning to thought, read cards   [D18]
  │         phases' ctx.emit       → round_start, check_start/end, verdict        [D12]
  │         check's tool-call chunks → the check card and its prompt       [D13] [D25]
  └─ ctx.emit(summary)
  to_updates = to_session_updates(event) + volley's emit mapper                    [D13]
    round → "**Round N**" [D19]  check → execute card + console block
    verdict → thought            summary → the turn's last message
state: <root>/<run_id>/, root $XDG_STATE_HOME/volley under acp | <workspace>/.volley/ on the CLI
```

## Decisions

- <a id="d1"></a>**D1 (stream-inner-run)**: When `run_volley` gets a `trajectory` sink, it runs its flow through `run.stream` with `tee_logger(file logger, sink)` and closes the handle's own event stream at once, since the sink is the consumer. The file logger drops `model_chunk` events there, so a run's `trajectory.jsonl` holds the same kinds of event as a CLI run's. Without a sink, `run_volley` keeps today's `run` and single file sink, *because* fascicle's `model_call` records `model_chunk` only under `ctx.streaming` (`src/model_call.ts`), which only `run.stream` sets (`src/core/runner.ts`). `serve_acp` maps nothing else to text, cards, or approval anchors, so the spec's tee on a plain `run` would reach Zed as bare spans, and every streamed token kept in the file would pile up under the acp state root. Settles [Q10 (trajectory-growth)](#q10).
- <a id="d2"></a>**D2 (seat-deps)**: `FlowDeps.engines` grows into `FlowDeps.seats`, per seat `{ engine, tools?, on_tool_approval? }`. The critic takes no approval, since its reads never ask. `run_volley`'s deps gain `seats?` and `trajectory?`, `deps.engine` still serves both seats, and an absent `tools` means today's set, *because* the spec grows the existing seam rather than adding parallel fields, and "leaving them out changes nothing" has to be testable as identical generate options.
- <a id="d3"></a>**D3 (openrouter-entry)**: An `openrouter` seat's provider entry is `{ api_key, base_url, transport: 'native', x_title: 'volley' }`. Its URL comes from one `SEAT_URL_SOURCES` row (`VOLLEY_OPENROUTER_URL`, default `https://openrouter.ai/api/v1`, trailing slashes stripped) and its key from `OPENROUTER_API_KEY`. A seat whose key is unset is a config error naming the variable (exit 5) before any work, *because* `with_providers` replaces a provider's whole entry, so a derived critic engine needs the key and the transport too, and fascicle's own "requires a non-empty api_key" doesn't say where the key comes from.
- <a id="d4"></a>**D4 (openrouter-seat)**: An `openrouter` seat takes the non-`claude_cli` branch wherever one exists:
  - on the CLI, its builder gets volley's tools, `bash` included, under the containment gate and preflight, with today's tool-loop settings (`max_steps`, salvage, one call per step);
  - its critic gets volley's reads and the retry and degrade ladder;
  - `--dry-run` probes its endpoint but runs no canary;
  - the summary records its transport as `native`.

  *Because* a seat with `bash` needs the same blast-radius rule wherever its model runs, and a canary that costs nothing on Ollama costs money on OpenRouter.
- <a id="d5"></a>**D5 (state-layout)**: `--state-dir <root>`, or `state_dir` in a config file, holds each run at `<root>/<run_id>/`. With neither, the CLI keeps `<workspace>/.volley/` and its `.volley.bak.<stamp>` rotation. Under acp the root defaults to `$XDG_STATE_HOME/volley`, else `~/.local/state/volley`. `volley resume` takes the flag too, and `config.json` records the resolved `state_dir`, *because* a per-run directory never needs rotating, `resume` finds a run by its id, and the CLI's default doesn't move.
- <a id="d6"></a>**D6 (critic-state-note)**: The critic presets' line about prior iteration state under `.volley/iterations/` is said only when the run's state sits inside the build root, *because* with state elsewhere, a local critic's confined reads can't reach it and would spend steps on a path that isn't there.
- <a id="d7"></a>**D7 (acp-tool-sets)**: Under acp, the builder gets `workspace_tools(session, { command_env, ignore })` plus volley's `finish`, and never volley's `write_file`, `edit_file`, `bash`, or `fetch`. The critic gets that set's `read_file`, `list_files`, and `search`. Both sets are built from a copy of the session whose roots are `session.cwd` alone, and `ignore` is volley's own `IGNORED_DIRS`, *because* volley's tools set no `needs_approval` and would act unasked in Manual, the check, the change list, and the critic all look only at `session.cwd`, and a seat should see the same tree under acp as on the CLI. Settles [Q13 (extra-roots)](#q13).
- <a id="d8"></a>**D8 (acp-prompts)**: Each seat's deps name its tool set, `'volley'` (the default) or `'acp'`, and the prompt resolvers pick a `harness_append_acp.md` preset by it. The builder's acp preset names fascicle's tools (`run_command`, `search`, …) and says what `tool_approval_denied` means, modeled on acp-coder's `prompts/coder.md`, *because* the local presets name `bash` and `search_files`, which don't exist under acp, and a builder that never had to ask needs telling what a refusal means.
- <a id="d9"></a>**D9 (acp-flags)**: `volley acp` declares these options:
  - the seat options, lifted out of the run command into one helper both commands share: the builder's and the critic's model, provider, and URL, `--builder-max-steps`, and `--allow-unsandboxed-builder`;
  - `--critic`, `--check`, `--max-iterations`, `--max-cost-usd`, and `--state-dir`;
  - `--worktree`, `--git`, and `--json`, declared only so they can be refused.

  It also refuses a `claude_cli` builder. Each refusal is a config error with its reason (exit 5), raised before serving, *because* cac answers an undeclared option with a bare "Unknown option", and a refusal at startup shows in Zed's agent log before any session opens.
- <a id="d10"></a>**D10 (turn-task)**: Each prompt is a fresh run on `session.cwd`, and its task and its criteria are both the rendered conversation. Each `turn.history` entry comes first, in order:
  - a `cancelled` entry is marked stopped, in acp-agent's `to_messages` wording;
  - a user entry drops its `<context ref="…">` blocks and keeps a one-line note naming each file that was attached;
  - an agent entry is cut to its last 2,000 characters, where the summary sits.

  `turn.text` follows, with its own `<context>` blocks whole. *Because* a follow-up such as "keep going" or "make it faster" names no criteria of its own, and an attached file is still on disk, so repeating its text in every later task and criteria would only crowd a local critic's context. This reads the spec's "the criteria default to the prompt" as the prompt volley is handed. Settles [Q9 (attached-files)](#q9).
- <a id="d11"></a>**D11 (acp-routing)**: The per-session flow is one step, `acp_turn`. Its `stream` sends `builder` to `message` and every other step to `none`, its `to_text` returns `''`, and its run gets a quiet renderer on stderr, *because* the critic's calls stream raw verdict JSON, the summary already arrives as the last message ([D12 (emit-events)](#d12)), and a step id matching a model call's would skew the run counts `span_start` keeps.
- <a id="d12"></a>**D12 (emit-events)**: Volley's progress events are `ctx.emit` payloads discriminated by a `volley` field:
  - `round_start`, from the build phase;
  - `check_start` and `check_end`, from the check phase;
  - `verdict`, from the critique phase;
  - `summary`, from `acp_turn` once `run_volley` returns or fails ([D14 (failed-turn)](#d14)).

  On the CLI they land in the trajectory. *Because* `ctx.emit` overwrites `kind` with `'emit'`, and `to_session_updates` maps no `emit` unless a `to_updates` wrapper adds to it.
- <a id="d13"></a>**D13 (check-card)**: Under acp, the check's card opens from tool-call chunks that the check phase records as `model_chunk` events under step id `check` whenever `ctx.streaming` is set, as `model_call` does: the call's start, the command as its input, and its result. volley's `to_updates` wrapper gives that card the `execute` look. It's titled with the check's command (`pnpm exec checkride --json`, or the `--check` command), and it closes `completed` or `failed` with the output in a `console` block cut at 32,000 bytes, as `run_command`'s output is. The `check_start` and `check_end` emits map to nothing there, *because* fascicle's approver anchors a prompt only on a card that a `model_chunk` `tool_call_start` opened ([D25 (check-approval)](#d25)), a long `pnpm test` should show as running while it runs, and a stop mid-check should land on a card the user can see.
- <a id="d14"></a>**D14 (failed-turn)**: A run that throws anything but an abort still ends the turn normally. `acp_turn` catches the failure and emits a failure summary naming the round, the phase, and the error, and the run's state directory keeps the failed summary. An abort, meaning the turn's own signal fired, still propagates, so that turn ends as cancelled, *because* `acp_agent` drops a turn that throws from the session's history, and a "try again" would then find no request to retry. Settles [Q8 (failure-history)](#q8), reversing the first draft, which ended the turn as an error.
- <a id="d15"></a>**D15 (command-gate)**: Under acp, `resolve_config` skips its refusal of an uncontained builder. When volley isn't contained (`VOLLEY_CONTAINED`) and isn't opted out (`--allow-unsandboxed-builder` or `VOLLEY_ALLOW_UNSANDBOXED_BUILDER`), the builder's `run_command` gets a `needs_approval` that is always true, *because* the user can switch modes mid-turn, so only a gate on each call holds. An "Always allow `pnpm test`" grant the user picks still counts as asked.
- <a id="d16"></a>**D16 (key-strip)**: `src/engine.ts` owns the list of credential variables a seat reads, `OPENROUTER_API_KEY` and `ANTHROPIC_API_KEY`. Under acp, the builder's `command_env` is the agent's environment minus exactly those, `PATH` kept. The check runs with the same environment, through a new `env` on `spawn_capture`, and the CLI's check keeps inheriting, *because* one list can't drift between the engine and the strip, and in Accept edits and Auto the builder can edit a test that the check then runs.
- <a id="d17"></a>**D17 (sdk-pin)**: `@agentclientprotocol/sdk` lands at exactly `1.8.0` in step 5, the change that first calls `serve_acp`, and its zod peer (`^3.25.0 || ^4.0.0`) takes the pinned 4.4.3. If fallow reads it as unused because only fascicle loads it, it joins `ignoreDependencies` beside `ai`, with the same comment, *because* 1.8.0 clears the 48-hour window where 1.9.0 (published 2026-10-16) doesn't, and `workspace_tools` loads without the SDK, so step 4 doesn't need it.
- <a id="d18"></a>**D18 (critic-cards)**: The critic's read cards show in Zed. `stream` routes only text, so each `read_file`, `list_files`, and `search` call the critic makes still opens a card, and nothing filters them out, *because* they never ask, and they show the evidence behind the verdict thought.
- <a id="d19"></a>**D19 (round-in-reply)**: Each round opens with a short `**Round N**` line in the reply, *because* the builder's text is the reply, and without a marker two rounds of it run together, with nothing to show where the critic sent the work back. Settles [Q1 (round-lines)](#q1).
- <a id="d20"></a>**D20 (cli-critic-allowed)**: A `claude_cli` critic is allowed under acp, and only a `claude_cli` builder is refused, *because* the critic only reads (its writes and `Bash` are disallowed), so it bypasses no Zed prompt, and refusing it would block a local builder with a Claude critic. Its reads show as plain cards ([D18 (critic-cards)](#d18)), and [D16 (key-strip)](#d16) keeps `ANTHROPIC_API_KEY` out of commands. Settles [Q2 (cli-critic)](#q2).
- <a id="d21"></a>**D21 (acp-iterations-3)**: `--max-iterations` defaults to 3 under acp, and the CLI keeps 10, *because* no cost cap can trip on an OpenRouter seat, so the round cap is the only guard on spend, and the user can follow a run with another prompt. Settles [Q3 (acp-iterations)](#q3).
- <a id="d22"></a>**D22 (no-atomic-writes)**: V6's atomic writes stay out of this build, parked for a change of their own, *because* they protect `volley resume`, which acp doesn't offer, and step 3 is already a path change across five modules. Settles [Q4 (atomic-writes)](#q4).
- <a id="d23"></a>**D23 (matrix-dir-stays)**: `.volley-matrix/` stays in the workspace, and `matrix` gets no `--state-dir`. A base config's `state_dir` moves only each seat's run state, and matrix reads each seat's summary back from there, *because* the sweep is a report the operator reads, and matrix never runs under acp. Settles [Q5 (matrix-dir)](#q5).
- <a id="d24"></a>**D24 (acp-seats-required)**: Under acp, `--builder-provider`, `--builder-model`, `--critic-provider`, and `--critic-model` are required. A missing one is refused at startup (exit 5), in one message naming every missing flag, *because* the CLI's defaults (`claude_cli` on `opus`) would make a bare `volley acp` refuse itself, and a default OpenRouter model would spend money on a model the Zed entry never names. Settles [Q6 (acp-seat-flags)](#q6).
- <a id="d25"></a>**D25 (check-approval)**: Under acp, the check asks before it runs whenever a builder command would: always when volley is uncontained and not opted out ([D15 (command-gate)](#d15)), and otherwise whenever the session's mode asks before commands. It asks through `session.approve` on its own card ([D13 (check-card)](#d13)), under a tool name outside fascicle's gated three, so only Allow and Reject are offered. A rejected check is recorded as a failed check, with the refusal as its output, *because* in Accept edits and Auto the builder can rewrite the code the check runs, and an "always" grant for checkride's `pnpm exec` would also cover the builder's commands. Settles [Q7 (check-asks)](#q7).
- <a id="d26"></a>**D26 (summary-content)**: The summary message says whether the run converged, in how many rounds, and with what last verdict. When the run didn't converge, it also lists the last unmet criteria, and it names any gate edits and any degraded critic verdict; a failed run's summary says what failed instead ([D14 (failed-turn)](#d14)). Other warnings stay on stderr, *because* stderr reaches only Zed's agent log, and the verdict thought isn't kept in history, so the next "keep going" turn learns what's still missing only from the summary's text. Settles [Q11 (summary-content)](#q11).
- <a id="d27"></a>**D27 (startup-resolve)**: At startup, `volley acp` runs its flags through `resolve_config` once, against the system temp directory with a placeholder prompt, so any config error, the refusals included, exits 5 before serving. Each turn resolves again against `session.cwd`, *because* otherwise a bad flag or an unset `OPENROUTER_API_KEY` ([D3 (openrouter-entry)](#d3)) would fail every prompt rather than failing once at startup, where Zed's agent log shows it. Settles [Q12 (startup-config)](#q12).
- <a id="d28"></a>**D28 (acp-agent-options)**: On fascicle 0.16.3, `acp_serve_config` sets `additional_directories: false`, and, when volley is uncontained and not opted out, `modes: ['manual', 'accept_edits']`. Both seats' tools are built from the session itself, with no `cwd_only` copy and no `run_command` wrapper, so the check asks through `run_command`'s own gate. This keeps what [D7 (acp-tool-sets)](#d7) and [D15 (command-gate)](#d15) decide and replaces how they do it, *because* fascicle 0.16 keys a session's cards and prompts on the session object, so a copy loses the diffs, the titled cards, and the "Always allow" grant, and a replaced `needs_approval` gets the plain prompt. fascicle#15 moved both needs into `ServeAcpConfig`: a client sends no extra folders to an agent that doesn't advertise them, and no one can switch to Auto when it isn't offered.
- <a id="d29"></a>**D29 (retry-label)**: The critic's retry step and its fallback, in `src/flow.ts` and in the README's diagram copy, say they act on every provider but `claude_cli`: the retry on a stream death, and the fallback on a critic that keeps dying or runs out of steps. *Because* `is_retryable_critic_error` and `is_degradable_critic_error` each exclude only `claude_cli`, so an `openrouter` critic retries and degrades too, and the diagram is the account of the flow that a reader trusts. The fallback row joined at the harvest after step 11.

## Constraints

- <a id="c1"></a>**C1 (house-style)**: snake_case values and file names; no classes or `this`; errors discriminated by `kind`; `create_engine` only in `src/engine.ts`; `.js` import extensions; no default exports; no deep sibling imports (`../dir/file.js`); and no loops in `src/flow.ts`, `src/phases.ts`, or `src/orchestrator.ts`. All of these are enforced by `rules/`, so new ACP modules sit at the top level of `src/`.
- <a id="c2"></a>**C2 (exact-pins)**: Dependencies are pinned exactly (`.npmrc` sets `save-exact`) at versions past pnpm's 48-hour release-age window. fascicle and checkride are exempt (`pnpm-workspace.yaml`), and zod stays at 4.4.3, fascicle's exact peer.
- <a id="c3"></a>**C3 (arrive-when-used)**: fallow fails on unused exports and dependencies, so each export and each dependency arrives in the step that first uses it.
- <a id="c4"></a>**C4 (stdout-protocol)**: Under `acp`, stdout carries only the protocol. The renderer writes to stderr, `--json` is refused, the check and volley's git calls capture their output, and nothing calls `console.log` or writes to `process.stdout`.
- <a id="c5"></a>**C5 (cli-unchanged)**: The plain CLI's behavior and exit codes stay as they are. What it gains is additive: the `openrouter` provider, `--state-dir` (unset keeps today's `.volley/`), and the new emit events in its trajectory.
- <a id="c6"></a>**C6 (check-gates)**: `pnpm check` (checkride: types, lint, struct, dead, dupes, test, and links) is green at the end of every step.

## Steps

1. [x] feat(provider): add an openrouter seat provider, **done when:** an integration test runs both seats on `openrouter` against a stub OpenAI-compatible server, the way `test/integration/seat_urls.test.ts` stubs Ollama (fascicle's `openrouter_native` tests show the SSE frames, usage included), and the run succeeds, with each seat's `POST /v1/chat/completions` carrying `Authorization: Bearer <key>`, `X-Title: volley`, and its own model; `--dry-run` probes each seat's URL and posts nothing; an unset `OPENROUTER_API_KEY` exits 5 naming it; an uncontained `openrouter` builder is refused without `--allow-unsandboxed-builder`; the summary's transport reads `native`; `--help` lists `openrouter` for both seats ([D3 (openrouter-entry)](#d3), [D4 (openrouter-seat)](#d4)); the seat options are declared through one helper that `acp` can share ([D9 (acp-flags)](#d9)), and the run command's `--help` lists the same options as before; `pnpm check` green
   - seam: `src/types.ts`, `src/config.ts`, `src/engine.ts`, `src/builder.ts`, `src/critic/run.ts`, `src/critic/prompt.ts`, `src/preflight.ts`, `src/summary.ts`, `src/cli.ts`, `.env.example`, `test/helpers/openai_stub.ts` (new), `test/integration/openrouter.test.ts` (new), `test/integration/cli.test.ts`, `test/unit/config.test.ts`, `test/unit/engine_url.test.ts`, `test/unit/preflight.test.ts`, `test/unit/summary.test.ts`
   - model: sonnet (the spec's §1 lists every branch point, and the stub copies a known pattern)
2. [x] feat(orchestrator): inject seat tools, approval, and a trajectory sink, **done when:** tests show three things: with none of the new deps, both seats' generate options and the file trajectory's event kinds match today's; injected tools and the builder's `on_tool_approval` reach their own seat's generate call and no other; and a `trajectory` sink receives the run's `span_start` events and the builder's `model_chunk` events through `run.stream` ([D1 (stream-inner-run)](#d1), [D2 (seat-deps)](#d2)), while the file logger gets every event except those `model_chunk` ones; `pnpm check` green
   - seam: `src/orchestrator.ts`, `src/flow.ts`, `src/diagram.ts`, `src/builder.ts`, `src/critic/run.ts`, `src/engine.ts`, `test/helpers/mock_engine.ts`, `test/integration/seat_deps.test.ts` (new)
   - model: opus (the `run.stream` switch, and a "changes nothing" test that has to be exact)
3. [x] feat(state): add --state-dir to keep run state out of the workspace, **done when:** tests show a run with `--state-dir <root>` writes its config, summary, trajectory, feedback, verdict, and iterations under `<root>/<run_id>/` and nothing in the workspace; with no flag, every path is today's `.volley/`, rotation included; `volley resume <id> --state-dir <root>` resumes such a run ([D5 (state-layout)](#d5)); the critic's prompt drops the `.volley/iterations/` line when state is outside the build root ([D6 (critic-state-note)](#d6)); a matrix seat whose base config sets `state_dir` is read back from there, while `.volley-matrix/` stays in the workspace ([D23 (matrix-dir-stays)](#d23)); `pnpm check` green
   - seam: `src/types.ts`, `src/config.ts`, `src/workspace.ts`, `src/orchestrator.ts`, `src/summary.ts`, `src/iteration.ts`, `src/matrix.ts`, `src/cli.ts`, `src/critic/prompt.ts`, `src/critic/presets/harness_append.md`, `src/critic/presets/harness_append_local.md`, `src/render/renderer.ts`, `test/integration/state_dir.test.ts` (new), `test/integration/resume.test.ts`, `test/unit/critic_prompt.test.ts`
   - model: sonnet (one path rule threaded through known call sites)
4. [x] feat(acp): give acp seats fascicle's workspace tools and prompts, **done when:** unit tests show the acp builder set is fascicle's six workspace tools plus volley's `finish`, with no `bash`, `fetch`, or volley write tool, `ignore` set to `IGNORED_DIRS`, and a `command_env` passed through; the acp critic set is exactly `read_file`, `list_files`, and `search`, none with a `needs_approval`; both sets refuse a path under one of the session's additional directories; a seat holding an acp set gets the acp preset naming `run_command`, `search`, and `tool_approval_denied`, while a seat with no injected set gets today's prompt byte for byte ([D7 (acp-tool-sets)](#d7), [D8 (acp-prompts)](#d8)); `pnpm check` green
   - seam: `src/acp_tools.ts` (new), `src/builder/tools.ts`, `src/workspace_tools.ts`, `src/builder.ts`, `src/critic/prompt.ts`, `src/builder/presets/harness_append_acp.md` (new), `src/critic/presets/harness_append_acp.md` (new), `test/unit/acp_tools.test.ts` (new), `test/unit/builder_prompt.test.ts`, `test/unit/critic_prompt.test.ts`
   - model: opus (the presets are prompt-writing that steers both seats under approval)
5. [x] feat(acp): serve volley to Zed as an ACP agent, **done when:** a spawn test pipes one `initialize` request into `tsx src/cli.ts acp` with seat flags and reads exactly one JSON-RPC response on stdout, naming agent `volley` at volley's version; `volley acp --worktree`, `--git`, `--json`, and a `claude_cli` builder each exit 5 with their reason before serving ([D9 (acp-flags)](#d9)), a missing seat flag exits 5 with every missing flag named ([D24 (acp-seats-required)](#d24)), an unset `OPENROUTER_API_KEY` exits 5 at startup too ([D27 (startup-resolve)](#d27)), a `claude_cli` critic is accepted ([D20 (cli-critic-allowed)](#d20)), and `--max-iterations` defaults to 3 ([D21 (acp-iterations-3)](#d21)); an in-process test sends one prompt through `acp_agent` and the SDK's client with both seats on the stub server, and the turn ends `end_turn` with the builder's text as the reply and no `.volley` in the workspace ([D11 (acp-routing)](#d11)); `@agentclientprotocol/sdk` is pinned at exactly 1.8.0 ([D17 (sdk-pin)](#d17)); `pnpm check` green
   - seam: `src/acp.ts` (new), `src/cli.ts`, `package.json`, `pnpm-lock.yaml`, `fallow.toml`, `test/helpers/acp_client.ts` (new), `test/integration/acp_cli.test.ts` (new)
   - model: opus (serve_acp wiring, a per-session flow, the startup resolve, and an in-process turn test)
6. [x] feat(acp): show rounds, the check, and the verdict in Zed, **done when:** unit tests over the `to_updates` wrapper map each [D12 (emit-events)](#d12) event: a `**Round N**` line in the reply ([D19 (round-in-reply)](#d19)), an `execute` check card opened and closed with its `console` block ([D13 (check-card)](#d13)), a verdict thought carrying the feedback and the unmet criteria, and one summary message, last, carrying what [D26 (summary-content)](#d26) lists, or a failure summary for a run that threw ([D14 (failed-turn)](#d14)); the same events land in a CLI run's `.volley/trajectory.jsonl`; the history renders ahead of the prompt, with a `cancelled` entry marked stopped, an earlier user entry without its `<context>` blocks, and an agent entry cut to its tail ([D10 (turn-task)](#d10)); `pnpm check` green
   - seam: `src/phases.ts`, `src/acp.ts`, `src/acp_progress.ts` (new), `test/unit/acp_progress.test.ts` (new), `test/integration/happy_path.test.ts`
   - model: sonnet (the events and their ACP shapes are specified, and fascicle's `presentation.ts` shows the card fields)
7. [x] feat(acp): ask before uncontained commands and hide provider keys, **done when:** tests show that under acp, uncontained and not opted out, `run_command`'s `needs_approval` is true in all three modes, while contained (`VOLLEY_CONTAINED=1`) or opted out it follows the mode ([D15 (command-gate)](#d15)); `resolve_config` no longer refuses an uncontained builder under acp but still does on the CLI; a command run through the acp builder set, and the check under both runners, see `PATH` but neither `OPENROUTER_API_KEY` nor `ANTHROPIC_API_KEY` ([D16 (key-strip)](#d16)); the CLI's check still inherits the whole environment; under acp the check asks through `session.approve` whenever a builder command would, offering only Allow and Reject, and a rejected check is recorded as failed ([D25 (check-approval)](#d25)); `pnpm check` green
   - seam: `src/acp_tools.ts`, `src/acp.ts`, `src/config.ts`, `src/engine.ts`, `src/orchestrator.ts`, `src/flow.ts`, `src/phases.ts`, `src/check/checkride.ts`, `src/check/command.ts`, `test/unit/acp_tools.test.ts`, `test/unit/check_command.test.ts`, `test/integration/checkride_gate.test.ts`, `test/unit/config.test.ts`
   - model: sonnet (the spec's §5 specifies it)
8. [x] test(acp): drive a whole volley turn through an in-process ACP client, **done when:** an integration test connects volley's acp config through `acp_agent` to the SDK's in-process client, runs real engines against a stub OpenAI-compatible server that scripts the builder's tool calls, and asserts the builder's cards; one permission request allowed, whose edit lands on disk, and one rejected, whose command never runs while the builder reads `tool_approval_denied`; the check's `execute` card, after a permission request the client allows ([D25 (check-approval)](#d25)); the verdict thought; and the summary as the last message, with the turn ending `end_turn` and no `.volley` in the workspace; `pnpm check` green
   - seam: `test/integration/acp_turn.test.ts` (new), `test/helpers/openai_stub.ts`, `test/helpers/acp_client.ts`
   - model: opus (strong-assertion test authoring over a scripted stub)
9. [x] docs(readme): document volley acp, OpenRouter, and the Zed setup, **done when:** the README covers `volley acp` (its flags and refusals, the modes, the uncontained command rule, when the check asks, and where state goes and that it's safe to delete); the `openrouter` provider (`OPENROUTER_API_KEY`, `VOLLEY_OPENROUTER_URL`, seat URLs, no cost or reasoning yet so `--max-iterations` is the guard, and `openrouter.ai` egress for a contained seat); `--state-dir` in the flag table and under Run artifacts; and the Zed `agent_servers` snippet with `PATH` and "run `pnpm build` first"; every flag it names matches `src/cli.ts`; `pnpm check` green, the links slot included
   - seam: `README.md`
   - model: sonnet (docs written against shipped flags)
10. [x] test(acp): script and pass the live check in Zed, **done when:** the README carries a short numbered check modeled on acp-coder's eight steps, and a person runs it in Zed against a scratch repo with a `node --test` suite, in Manual unless a step says otherwise: (1) a prompt streams the builder's work as the reply; (2) an edit asks with its diff, and Allow keeps the diff on the card; (3) a command asks before it runs; (4) the check asks, then runs as a command card; (5) the verdict shows as a thought; (6) the turn ends with the summary; (7) stop during a `sleep 60` command ends the turn cancelled, and `pgrep -fl 'sleep 60'` finds nothing; (8) in Auto, uncontained, a command still asks; and a command printing `$OPENROUTER_API_KEY` prints nothing, and the repo holds no `.volley`; the results go in the build log
   - seam: `README.md`
11. [x] chore(deps): move to fascicle 0.16.3 and its acp agent options, **done when:** fascicle is pinned at exactly 0.16.3; `acp_serve_config` sets `additional_directories: false`, and `modes: ['manual', 'accept_edits']` when uncontained and not opted out; `cwd_only` and the always-ask wrapper are gone ([D28 (acp-agent-options)](#d28)); tests show that uncontained, a session offers Manual and Accept edits only and refuses Auto, while contained or opted out it offers all three; a `session/new` that sends additional directories is refused; the check asks in Accept edits when uncontained; step 8's turn test asserts the edit card closes with its diff and the command prompt offers "Always allow" for that exact command line; `cost_source_of` reports OpenRouter's cost as `provider_reported`; the critic's retry step and the README's diagram copy name every provider but `claude_cli` ([D29 (retry-label)](#d29)); the README's Auto row, its Zed check step 8 (uncontained, Auto isn't offered), its additional-directories note, a note that Zed falls back to Manual for an entry left on Auto, the exact-command "Always allow", and OpenRouter cost and reasoning (so `--max-cost-usd` trips, and nothing claims otherwise) all match 0.16.3; `pnpm check` green
   - seam: `package.json`, `pnpm-lock.yaml`, `src/acp.ts`, `src/acp_tools.ts`, `src/cost.ts`, `src/flow.ts`, `README.md`, `test/unit/acp_tools.test.ts`, `test/unit/cost.test.ts`, `test/integration/acp_cli.test.ts`, `test/integration/acp_turn.test.ts`
   - model: sonnet (fascicle#15's reply prescribes the change, and the tests to rewrite are named)
12. [ ] test(acp): run the live check in Zed, **done when:** a person runs the README's "Check it in Zed" against a scratch repo with a `node --test` suite, on fascicle 0.16.3, and every step holds, including whether the check's card keeps its command look while it asks (the open park on `kind: 'other'`); the results go in the build log
   - seam: `README.md`
13. [ ] docs(flow): name every provider but claude_cli on the critic's fallback row, **done when:** the critic fallback's `description` in `src/flow.ts`, the header diagram there, and the README's diagram copy say it judges without tools when a critic on any provider but `claude_cli` keeps dying or runs out of steps, not "a local critic" ([D29 (retry-label)](#d29)); `test/unit/flow_diagram.test.ts` holds all three in step; `pnpm check` green
   - seam: `src/flow.ts`, `README.md`
   - model: haiku (one description string and the diagram pasted twice)

## Build order

<!-- Optional: one line of comma-separated step numbers, such as `7, 8, 5, 10, 6`; empty means document order. `plumbbob order` writes it. -->

13, 12

## Open questions

<!--
Each question: the opener (anchored, slugged, tagged *resolve by:*), a *plain:* line
(what's at stake, cold), and a *lean:* line (the proposed answer). When one resolves,
swap *resolve by:* for *resolved:* <date, the call> ON THE OPENER LINE; the status
counter reads opener lines only (plumbbob D76).
-->

- <a id="q1"></a>**Q1 (round-lines)**: Do the round lines go to the reply or to the thought block? *resolved:* 2026-10-16, the reply ([D19 (round-in-reply)](#d19))
  - *plain:* Each round opens with a line such as `**Round 2**`. In the reply, it splits one round's builder text from the next, and it stays in the history whose tail feeds the next prompt ([D10 (turn-task)](#d10)). In the thought block, it sits folded with the verdicts, and the reply reads as one continuous builder answer followed by the summary.
  - *lean:* The reply, as the spec sketches. The builder's text is the reply, and without a marker two rounds of it run together, with nothing to show where the critic sent the work back.
- <a id="q2"></a>**Q2 (cli-critic)**: Is a `claude_cli` critic allowed under acp? *resolved:* 2026-10-16, allowed ([D20 (cli-critic-allowed)](#d20))
  - *plain:* The `claude_cli` builder is refused because the CLI's own tools and permission model bypass Zed's prompts. A `claude_cli` critic only reads, since its writes and `Bash` are disallowed, so it bypasses no prompt. But its reads show only as plain cards (the CLI's `Read`, `Grep`, and `Glob`), it brings a second credential (a Claude login, or an `ANTHROPIC_API_KEY` that [D16 (key-strip)](#d16) strips from commands), and it cuts against the spec's "one API key, no Claude Code CLI".
  - *lean:* Allow it. It can't edit or run anything, it runs on the host where its login works, and refusing it would block a local builder with a Claude critic for no safety gain.
- <a id="q3"></a>**Q3 (acp-iterations)**: What does `--max-iterations` default to under acp? *resolved:* 2026-10-16, 3 under acp, 10 on the CLI ([D21 (acp-iterations-3)](#d21))
  - *plain:* The CLI's default is 10. Under acp, no cost cap can trip on an OpenRouter seat, because fascicle records its cost as missing, so the round cap is the only guard on spend. Each prompt is also a fresh run the user can follow with another prompt.
  - *lean:* 3 under acp, matching the spec's Zed snippet, while the CLI keeps 10.
- <a id="q4"></a>**Q4 (atomic-writes)**: Do V6's atomic writes come in with `--state-dir`, as the spec suggests, or separately? *resolved:* 2026-10-16, separately, outside this build ([D22 (no-atomic-writes)](#d22))
  - *plain:* V6 (`research/agent-native-upgrades.md`) replaces each `.volley/` `writeFileSync` with a temp file in the same directory and a rename, so a crash mid-write can't leave a torn summary for `volley resume` to read back. The spec pairs it with `--state-dir` because both touch the same writers. Under acp there is no resume, and each turn writes a fresh run directory, so acp gains nothing from it.
  - *lean:* Separately, outside this build, parked for a small change of its own. Step 3 is already a path change across five modules, and V6 protects `resume`, a CLI path this build doesn't otherwise touch.
- <a id="q5"></a>**Q5 (matrix-dir)**: Does `--state-dir` also move `.volley-matrix/`? *resolved:* 2026-10-16, no, it stays in the workspace ([D23 (matrix-dir-stays)](#d23))
  - *plain:* `volley matrix` writes the sweep, each seat's summary and `matrix.json`, to `<workspace>/.volley-matrix/`, apart from each seat's `.volley/` run state, which it reads back to build its table. matrix never runs under acp, and the sweep is a report the operator reads.
  - *lean:* No. `.volley-matrix/` stays where it is, and `matrix` gets no flag. A base config's `state_dir` moves only each seat's run state, and matrix reads the seat's summary from there.
- <a id="q6"></a>**Q6 (acp-seat-flags)**: What does `volley acp` run when the Zed entry names no seats? *resolved:* 2026-10-16, all four seat flags required ([D24 (acp-seats-required)](#d24))
  - *plain:* The CLI defaults both seats to `claude_cli` on `opus`. Under acp a `claude_cli` builder is refused ([D9 (acp-flags)](#d9)), and `opus` isn't an OpenRouter model id, so the CLI's defaults would make a bare `volley acp` refuse itself. A default OpenRouter model instead would spend money on a model the Zed entry never names.
  - *lean:* Require `--builder-provider`, `--builder-model`, `--critic-provider`, and `--critic-model` under acp, refusing at startup with one message that names whichever are missing. The spec's Zed snippet sets all four anyway.
- <a id="q7"></a>**Q7 (check-asks)**: Should the check ask before it runs whenever a builder command would? *resolved:* 2026-10-16, yes, with Allow and Reject only ([D25 (check-approval)](#d25))
  - *plain:* [D15 (command-gate)](#d15) gates the builder's `run_command`, but the check is volley's own spawn, so it never asks. In Accept edits and Auto, the builder can rewrite a test or the `test` script without asking, and the next check runs that code unasked. [D16 (key-strip)](#d16) keeps the keys from it, but not its reach (SSH keys, other repos, the network), which is the same reach that kept `fetch` out of acp. Asking needs a card fascicle's approver knows, and only a `model_chunk` tool call registers one, so the check would have to record its card as a tool call. That reshapes [D13 (check-card)](#d13) and step 7.
  - *lean:* Yes. The check asks whenever a builder command would: always when uncontained, otherwise whenever the mode asks before commands. It asks on its own card with Allow and Reject only, since an "always" grant for checkride's `pnpm exec` would also cover the builder's commands. A rejected check counts as a failed one, so a round can't converge on work nobody checked.
- <a id="q8"></a>**Q8 (failure-history)**: Should a failed run end the turn as an error, as [D14 (failed-turn)](#d14) says, when fascicle then drops the turn from history? *resolved:* 2026-10-16, reversed: the turn ends with a failure summary ([D14 (failed-turn)](#d14))
  - *plain:* `acp_agent` records a turn in the session's history only when its flow returns or the turn is cancelled, so a flow that throws leaves no trace. Under [D14 (failed-turn)](#d14), a run that dies on a provider error, a broken check, or a config error vanishes from the conversation, and the user's "try again" reaches a fresh run with no request to retry. Its reason, that a failure dressed as a reply would read as an answer, weakens once the reply says plainly that it failed.
  - *lean:* Reverse [D14 (failed-turn)](#d14). `acp_turn` catches every failure except an abort and ends the turn normally, with a summary saying the run failed, on which round and phase, and why. History then keeps the request, so "try again" works, and an abort still ends the turn as cancelled.
- <a id="q9"></a>**Q9 (attached-files)**: Should earlier turns' @-mentioned files go into every later task and criteria? *resolved:* 2026-10-16, no, earlier turns drop their file text ([D10 (turn-task)](#d10))
  - *plain:* fascicle keeps each user entry's full `turn.text`, which includes a `<context ref="…">` block with the text of every file the user @-mentioned. [D10 (turn-task)](#d10) renders user entries whole and makes the rendered conversation the criteria too, so a file attached in turn 1 rides in both the builder's task and the critic's prompt on every later turn. A large file can overflow a 32k-context local critic, and the file is on disk anyway.
  - *lean:* Render each earlier user entry without its `<context>` blocks, keeping a one-line note of each file that was attached. The current turn keeps its blocks whole.
- <a id="q10"></a>**Q10 (trajectory-growth)**: Should a run's file trajectory keep every model chunk once [D1 (stream-inner-run)](#d1) tees it with the turn's stream? *resolved:* 2026-10-16, no, chunks stay out of the file and nothing is pruned ([D1 (stream-inner-run)](#d1))
  - *plain:* Under acp the inner run streams, so the file logger gets each streamed token as its own event, which a CLI run's trajectory never held. Each prompt also leaves a run directory under the [D5 (state-layout)](#d5) root, and nothing prunes them, so a busy day of prompts can add up to hundreds of megabytes.
  - *lean:* Keep `model_chunk` events out of the file sink, so a run's `trajectory.jsonl` holds the same kinds of event as a CLI run's, and step 2's done-when says so. Prune nothing in this build; the README names the root and says it's safe to delete.
- <a id="q11"></a>**Q11 (summary-content)**: What does the acp summary say beyond whether the run converged, its rounds, and the last verdict? *resolved:* 2026-10-16, the unmet criteria, gate edits, and a degraded verdict ([D26 (summary-content)](#d26))
  - *plain:* On the CLI, volley's warnings reach the operator on stderr: a gate edit, a builder that hit its step limit, a phase whose cost is unknown. A degraded critic verdict is marked only in `summary.json`. Under acp, stderr goes only to Zed's agent log, and the verdict thought isn't kept in history, so after a run that didn't converge, a "keep going" prompt starts a fresh run that never learns what the critic still found missing ([D10 (turn-task)](#d10)).
  - *lean:* The summary also lists the last unmet criteria when the run didn't converge, and names any gate edits and any degraded verdict. Other warnings stay on stderr.
- <a id="q12"></a>**Q12 (startup-config)**: Does `volley acp` resolve its whole config at startup, or check only the refusals there? *resolved:* 2026-10-16, the whole config, once ([D27 (startup-resolve)](#d27))
  - *plain:* [D9 (acp-flags)](#d9) and [D24 (acp-seats-required)](#d24) refuse their cases before serving. Any other config error would surface only at the first prompt, and again at every prompt after it: an unknown provider, an unset `OPENROUTER_API_KEY` ([D3 (openrouter-entry)](#d3)), a non-numeric cap, a missing `--critic` file. The workspace isn't known until a session opens, so a full resolve at startup needs a stand-in.
  - *lean:* Resolve the flags once at startup against a temp directory with a placeholder prompt, so any config error fails before Zed connects and shows in its agent log. Each turn then resolves again against `session.cwd`.
- <a id="q13"></a>**Q13 (extra-roots)**: Should the acp seats' tools reach the client's additional directories? *resolved:* 2026-10-16, no, both seats are confined to `session.cwd` ([D7 (acp-tool-sets)](#d7))
  - *plain:* A client can send more folders as `additionalDirectories` on `session/new` (fascicle advertises the capability), and `workspace_tools` accepts any path under them ([D7 (acp-tool-sets)](#d7)). But volley's check, its change list, and the critic's baseline all look only at `session.cwd`, so an edit in another folder would never be checked or reviewed.
  - *lean:* No. Build both seats' tools from a copy of the session whose roots are `session.cwd` alone, so the builder edits only what the check and the critic see.
- <a id="q14"></a>**Q14 (step-5-size)**: Should step 5 be cut down before it's built? *resolved:* 2026-10-16, kept whole, with the seat-option lift moved into step 1
  - *plain:* Step 5 lands in one diff: the serve config, the per-session flow, the seat options lifted into a shared helper, four refusals plus the missing-flag one ([D24 (acp-seats-required)](#d24)), the SDK pin, a spawn test, and an in-process turn test with a new client helper. That's a lot for one review pass. But splitting it in two would leave a first half that serves Zed and can't run a turn, which isn't useful on its own.
  - *lean:* Keep step 5 as one step, and move the seat-option lift into step 1, which already rewrites those help lines. Step 5 then stays one idea: `volley acp` exists and runs a turn.

## Verdicts

All six settled at the plan pause in one reply ("yes to all leans"):

- 2026-10-16: [Q1 (round-lines)](#q1) → chose the reply, because a marker there shows where the critic sent the work back; dropped the thought block.
- 2026-10-16: [Q2 (cli-critic)](#q2) → chose to allow a `claude_cli` critic, because it only reads; dropped the refusal.
- 2026-10-16: [Q3 (acp-iterations)](#q3) → chose 3 under acp, because the round cap is the only guard on spend over OpenRouter; dropped the CLI's 10 there.
- 2026-10-16: [Q4 (atomic-writes)](#q4) → chose to keep V6 out of this build, because it protects `resume`, which acp lacks; dropped pairing it with `--state-dir`.
- 2026-10-16: [Q5 (matrix-dir)](#q5) → chose to leave `.volley-matrix/` in the workspace, because it is the sweep's report; dropped moving it.
- 2026-10-16: [Q6 (acp-seat-flags)](#q6) → chose to require all four seat flags, because the CLI's defaults would refuse themselves and a default model would spend unasked; dropped defaulting to an OpenRouter model.

[Q7 (check-asks)](#q7) through [Q14 (step-5-size)](#q14) came out of the refine pass and were settled in one reply ("yes to leans"), along with a fix to step 2's file list (`src/diagram.ts`):

- 2026-10-16: [Q7 (check-asks)](#q7) → chose to make the check ask whenever a builder command would, because the builder can rewrite what it runs; dropped running it unasked.
- 2026-10-16: [Q8 (failure-history)](#q8) → chose to end a failed run's turn with a failure summary, because a turn that throws leaves no history to retry from; dropped the first draft of [D14 (failed-turn)](#d14).
- 2026-10-16: [Q9 (attached-files)](#q9) → chose to drop earlier turns' file text from history, because the files are on disk; dropped repeating them.
- 2026-10-16: [Q10 (trajectory-growth)](#q10) → chose to keep `model_chunk` events out of the file, because they'd pile up under the state root; dropped pruning for now.
- 2026-10-16: [Q11 (summary-content)](#q11) → chose to add the unmet criteria, gate edits, and a degraded verdict, because stderr never reaches the Zed thread; dropped the bare converged/rounds/verdict summary.
- 2026-10-16: [Q12 (startup-config)](#q12) → chose to resolve the whole config once at startup, because a bad flag would otherwise fail every prompt; dropped checking only the refusals there.
- 2026-10-16: [Q13 (extra-roots)](#q13) → chose to confine both seats to `session.cwd`, because the check and the critic look only there; dropped reaching additional directories.
- 2026-10-16: [Q14 (step-5-size)](#q14) → chose to keep step 5 whole and move the seat-option lift into step 1, because a split would leave a half that can't run a turn; dropped splitting it.

## Source

The spec this build absorbs, verbatim, then the planning brief that sliced it.

### `research/specs/volley-spec-acp.md`

````markdown
# volley — ACP spec (run volley from Zed on OpenRouter models)

A plan-ready specification for serving volley as an Agent Client Protocol (ACP) agent, so it runs from Zed's agent panel on the open repo, with seats on OpenRouter instead of the Claude Code CLI. Revised on 2026-10-16 against what fascicle 0.14.0 actually shipped as `fascicle/acp`.

Add a `volley acp` command that serves volley through fascicle's `serve_acp`, so a prompt in Zed's agent panel starts a volley run on the open repo. The builder's work streams as the reply and the critic's verdict as a thought. Every edit and command the builder makes goes through Zed's permission prompt, as often as the session's mode says. Seats gain an `openrouter` provider, so the whole thing runs on one API key, Claude included, with no Claude Code CLI.

This builds on `fascicle/acp` in fascicle 0.14.0: `serve_acp`, `workspace_tools`, session modes, and permission requests, all documented in fascicle's `docs/acp.md`. [fascicle#13](https://github.com/robmclarty/fascicle/issues/13) tracked the work and is still open. fascicle's `examples/acp-coder` is the reference coding agent. Volley is the first fascicle app with more than one model call to run in Zed, and its entry point should be a pattern another fascicle agent can copy.

## What fascicle 0.14.0 gives volley

These are the facts of the build that shape everything below.

- **Turns.** `serve_acp(config)` runs each prompt turn through `run.stream`, with the turn's abort and `install_signal_handlers: false`. A new prompt cancels the session's turn in flight and waits for it to settle. `console.log` goes to stderr, stdout carries only the protocol, and closing stdin, SIGTERM, and SIGINT abort every run.
- **Sessions.** `flow` can be a function of the `AcpSession`, called once per `session/new`. The session holds `id`, `cwd`, `additional_directories`, `roots`, `client_capabilities`, `mode()`, and `approve`. With `to_input: (turn) => turn`, the flow gets an `AcpTurn`:
  - `text`, with an @-mentioned file's text in a `<context ref="…">` block after the prompt;
  - `prompt`, the raw content blocks;
  - `history`, as `{ role, text, cancelled? }` entries.
- **What reaches Zed.** Only `model_chunk` events become session updates:
  - text goes where `stream(step_id)` routes it (`message`, `thought`, or `none`);
  - reasoning always goes to the thought block;
  - tool calls open cards.

  Each `span_start` advances a per-step run count, which keeps a model call's cards distinct when a loop runs it again. Spans, cost, and `emit` events map to nothing, unless `to_updates` wraps `to_session_updates` and adds to what it returns. `to_text(output)` is sent only when the turn sent no message text at all.
- **Workspace tools.** `workspace_tools(session, options)` returns `read_file`, `list_files`, `search`, `write_file`, `edit_file`, and `run_command`.
  - The file tools accept only paths whose real path lands under the session's roots.
  - `run_command` runs `/bin/sh -c` in a process group of its own. A cancel, its timeout (default 120 s), and its exit kill the whole group, and its output is capped (32 KB).
  - `command_env` replaces the environment commands run with.
  - `ignore` names what `list_files` and `search` skip: names, not globs, defaulting to `.git` and `node_modules`.
- **Approvals.** The mode gate lives in each workspace tool's `needs_approval`, which reads `session.mode()` at every call, so a switch in Zed mid-turn holds from the next call on.
  - Manual asks before every edit and command, Accept edits only before a command, and Auto never asks.
  - `session.approve`, passed as a model call's `on_tool_approval`, waits until the client has been sent the card it asks on, then shows an edit's diff and offers Allow, Reject, and an "always" for the session. It never fails open.
  - A tool without `needs_approval` never asks, in any mode.
- **Credentials and extras.**
  - The agent advertises no ACP auth methods, so keys come from the agent server entry's `env`.
  - MCP servers the client sends are ignored.
  - `@agentclientprotocol/sdk` (`^1.8.0`, with zod) is an optional peer, loaded only when an agent starts.
- **Not in 0.14.0.**
  - OpenRouter cost (fascicle's `research/openrouter-cost-spec.md`). An OpenRouter call still records its cost as missing.
  - OpenRouter reasoning (`research/openrouter-reasoning-spec.md`). The native OpenAI-compatible core sends the effort setting but emits no `reasoning` chunks, so an OpenRouter seat shows no reasoning in the thought block.

## Where volley stands (v0.6.1, plus per-seat URLs on main)

- **Providers.** Seats accept only `claude_cli`, `ollama`, and `lmstudio` (`src/types.ts:16,23`, validated in `src/config.ts:36-56`). No OpenRouter or Anthropic API path exists.
- **Seat URLs.** Each `ollama` or `lmstudio` seat can reach its own server (`builder_url` / `critic_url`, volley#2).
  - A seat's URL resolves from one table, `SEAT_URL_SOURCES` (`src/engine.ts:74`), through `seat_base_url` (`:115`).
  - `create_seat_engines` (`:254`) gives the critic an engine of its own, derived with `with_providers`, only when both seats share a provider at different URLs.
- **Tools.** The tool sets are hard-wired (`src/builder.ts:126-129`, `src/critic/run.ts:87`).
  - Volley's own tools set no `needs_approval` (`src/builder/tools.ts:479-588`), so under ACP its `write_file`, `edit_file`, `bash`, and `fetch` would run unasked in every mode.
  - The local builder's prompt and the local critic's harness name volley's tools (`bash`, `search_files`) in `src/builder/presets/harness_append_local.md` and `src/critic/presets/harness_append_local.md`, not fascicle's (`run_command`, `search`).
- **Injection.** Only the engine can be injected into `run_volley` (`src/orchestrator.ts:45-59`), and an injected engine serves both seats. Inside the flow, each seat takes its engine from `FlowDeps.engines` (`src/flow.ts`).
- **The run's events.** `run_volley` calls fascicle's `run` itself, and its only trajectory sink is `.volley/trajectory.jsonl` (`src/orchestrator.ts:169`). So none of its events reach an outer run, which is the only thing `serve_acp` maps. Its `Renderer` does receive every builder and critic chunk (`src/render/renderer.ts:36-46`).
- **The check.** It runs through an async `spawn` with its output captured (`spawn_capture` in `src/check/checkride.ts`), so nothing reaches stdout. It runs in a process group of its own, and an abort kills the whole group, the way `run_command` does, so a stopped `pnpm test` leaves no workers behind.
- **State.** Each run rotates `.volley/` inside the workspace (`src/workspace.ts:28-37`), and nothing adds it to `.gitignore`.
- **F1, fixed.** A non-CLI critic that runs out of steps before its verdict now goes to the tool-less pass, marked `degrade_cause: 'step_exhaustion'`, instead of exiting 6. The predicate excludes only `claude_cli`, so an OpenRouter critic is covered as soon as the provider exists.
- **fascicle.** Volley pins fascicle 0.14.0, which ships `fascicle/acp`, and builds on TypeScript 7 with tsdown.

## Proposal

### 1. An `openrouter` seat provider

- `--builder-provider openrouter` and `--critic-provider openrouter`, with `OPENROUTER_API_KEY` and an optional `VOLLEY_OPENROUTER_URL`. The engine builds it with `transport: 'native'`, so nothing extra gets installed, and sets `x_title: 'volley'` so OpenRouter attributes the traffic.
- Every place that branches on the provider today needs the new case:
  - `src/types.ts:16,23`;
  - `src/config.ts:36-56`, and the containment gate at `:326-343`;
  - in `src/engine.ts`, one `SEAT_URL_SOURCES` row (`VOLLEY_OPENROUTER_URL`, defaulting to `https://openrouter.ai/api/v1`) and an `openrouter` case in `seat_provider_config` (`:180`). That function returns the provider's whole entry, so the case carries the `api_key` and `transport: 'native'`, and a critic engine derived with `with_providers` keeps both;
  - `src/builder.ts:78-82` and `:98-135`;
  - `src/critic/run.ts:71-88` and `:103-106`;
  - `src/critic/prompt.ts:40-41`;
  - `src/preflight.ts:55-69`;
  - `src/summary.ts:36-38`;
  - the help text in `src/cli.ts:228-229,233-234`.
- With `openrouter` in the table, `--builder-url` / `--critic-url` apply to OpenRouter seats (a proxy, or another OpenAI-compatible gateway), and `--dry-run` probes their endpoints, with no further work.
- An OpenRouter builder gets volley's own tools from the CLI, `bash` included, so the containment gate applies to it the way it applies to a local builder. Under ACP it gets fascicle's workspace tools instead (§2).
- fascicle 0.14.0 still records OpenRouter costs as missing, so `--max-cost-usd` can't trip on an OpenRouter seat yet. Until fascicle's cost spec lands, `--max-iterations` is the guard, and `VOLLEY_PRICING_PATH` can supply prices.
- An OpenRouter seat streams no reasoning until fascicle's reasoning spec lands, so its thought block shows only what volley sends there itself (§3).
- This works from the CLI as well as under ACP.

### 2. Injectable tools, approval, and a trajectory sink

`run_volley`'s deps gain three things: per-seat tools, an `on_tool_approval` handler for the builder, and a `trajectory` logger that receives the run's events alongside `.volley/trajectory.jsonl` (combined with fascicle's `tee_logger`). Leaving them out keeps today's tools and today's single sink.

Each seat's engine already reaches the flow through the internal `FlowDeps.engines`. Grow that into per-seat deps (engine, tools, approval) rather than adding parallel fields. `deps.engine` keeps serving both seats.

Under ACP:

- **The builder** gets `workspace_tools(session, { command_env, ignore })` plus volley's `finish`.
  - None of volley's `write_file`, `edit_file`, or `bash`: they set no `needs_approval`, so they would edit and run commands unasked in Manual too.
  - Not `fetch` either, which would reach the network unasked. It can come back later behind a `needs_approval` of its own.
- **The critic** gets the read-only three, `read_file`, `list_files`, and `search`, which never ask.
- **Prompts.** The builder's system prompt and the critic's local harness name their tools (`src/builder.ts:63`, the two `harness_append_local.md` presets). They need an ACP variant that names fascicle's: `run_command` and `search`.

### 3. `volley acp`

- **The command.** It calls `serve_acp` with:
  - `name: 'volley'` and volley's version;
  - `default_mode: 'manual'`;
  - `to_input: (turn) => turn`;
  - a `flow` built per session.

  The flow is one step, with an id other than `builder` or the critic's (`acp_turn`), that runs `run_volley` with:
  - `install_signal_handlers: false` and `abort: ctx.abort`;
  - the session's tools and `session.approve`;
  - a quiet renderer on stderr;
  - `trajectory: ctx.trajectory`.
- **The step's `ctx.trajectory` is the bridge.** It is the turn's stream logger, so with it as the run's second sink, `serve_acp`'s mapper sees the inner run as if the flow were its own:
  - the builder's text arrives as the reply;
  - its workspace tool calls arrive as cards, which `session.approve` finds when it asks;
  - reasoning arrives as thoughts;
  - each `span_start` keeps a second round's cards apart from the first's.

  This replaces forwarding the renderer's chunks. Those carry no `span_start`, so on Ollama, which numbers tool calls from zero on every call, a second round's cards would land on the first round's.
- **Routing.** `stream` sends `builder` to `message`, and the critic's model calls (`critic_tools`, `critic_toolless`) to `none`. They stream raw verdict JSON. The critic's reasoning still reaches the thought block where its provider streams one.
- **Progress.** Volley's phases `ctx.emit` structured events: a round starting, the check's command and result, and the verdict. The ACP step emits the run's summary when `run_volley` returns. On the CLI these land in the trajectory for the viewer. Under ACP, a `to_updates` that wraps `to_session_updates` maps them:
  - **Round start:** a short message line, such as `**Round 2**`.
  - **The check:** an `execute` card titled with its command, with its output in a `console` block.
  - **The verdict:** a thought, with the feedback and the unmet criteria.
  - **The summary:** the turn's last message, saying whether the run converged, how many rounds it took, and the last verdict.

  `to_text` can't carry the summary, because it's sent only when no message text streamed, and the builder's did.
- **Each prompt is a fresh run, in place, on `session.cwd`.**
  - The task is `turn.text`, with `turn.history` rendered in front of it.
    - A history entry marked `cancelled` is rendered as stopped, so the builder doesn't resume a request the user stopped.
    - An agent entry is rendered by its tail, where volley's summary sits, so one long build doesn't crowd the next prompt.
  - The criteria default to the prompt.
  - Everything else comes from the command's flags (`--builder-*` and `--critic-*`, seat URLs included, `--check`, `--max-iterations`), the same as a normal run. Lift the seat options out of the run command (`src/cli.ts:227-234`) so both commands declare them once.
  - `--worktree` and `--git` are refused under `acp` for now, because a sibling worktree sits outside the project Zed has open.
  - A `claude_cli` builder is refused under `acp`. The Claude CLI runs its own tools and its own permission model, so its edits would never reach Zed's prompts.
- **Stdout.** Nothing writes to it but the protocol. The renderer stays on stderr, and `--json` is refused. The check and volley's git calls already capture their output.
- **No `engine` option.** Volley passes no `engine` to `serve_acp`. Each run builds its seat engines and disposes them in its own `finally`.

### 4. State outside the workspace

Under `acp`, `.volley/` would be rotated in the user's repo on every prompt. `list_files` and `search` would show it to both seats, since `ignore` takes names and can't match each `.volley.bak.<stamp>`.

Write it under a state directory instead (`--state-dir`, defaulting to somewhere like `$XDG_STATE_HOME/volley/<run_id>`), and offer the same flag in the CLI. The trajectory file moves with it, so `fascicle-viewer` can follow a run next to Zed. Do it together with V6's atomic writes (`research/agent-native-upgrades.md`). Until it lands, pass `ignore: ['.git', 'node_modules', '.volley']`.

### 5. Containment under ACP

- **No startup check is possible.** The mode is read at every tool call, and the user can change it in Zed at any point, mid-turn included.
- **Approval replaces the container for commands.** Under `acp`, a person approving each command takes the container's place. So `volley acp` drops `resolve_config`'s refusal of an uncontained builder (`src/config.ts:326-343`) and enforces the rule per command instead.
- **The per-command rule.** When volley isn't contained and `VOLLEY_ALLOW_UNSANDBOXED_BUILDER` doesn't opt out, the builder's `run_command` gets a `needs_approval` that always asks. Auto still edits without asking, inside the session's roots, but a command never runs unasked outside a container.
- **Commands run without the provider keys.** The builder's commands get a `command_env` of the agent's environment minus `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, and the other keys a seat reads, the way acp-coder builds it, `PATH` included.
- **So does the check.** Run it with the same environment. In Accept edits and Auto, the builder can edit a test without being asked, and the check then runs that test.

The image's network allowlist only reaches the host gateway (`src/sandbox.ts:60-87`), so a contained OpenRouter seat also needs `openrouter.ai` allowed. That matters once volley runs under a headless host such as kandev.

Seat URLs meet the same wall. A loopback seat URL crosses to `VOLLEY_MODEL_HOST` on its own port, but a seat on another machine is reachable from inside only through a host port forward. The allowlist could be derived from the seats' resolved endpoints (`seat_base_url`) rather than listed by hand.

### 6. Prerequisites

All met as of 2026-10-16:

- F1 is fixed.
- The check's process group dies with the run.
- volley is on fascicle 0.14.0 and TypeScript 7.

The one dependency left comes with the build itself. Add `@agentclientprotocol/sdk` to volley's dependencies, pinned exactly, in the change that first imports `fascicle/acp`, since until then the dead-code check would flag it. 1.8.0 clears pnpm's two-day release-age window; 1.9.0 was published on 2026-10-16.

## Zed setup

```json
{
  "agent_servers": {
    "Volley": {
      "type": "custom",
      "command": "node",
      "args": [
        "/abs/path/to/volley/dist/cli.js", "acp",
        "--builder-provider", "openrouter", "--builder-model", "anthropic/claude-sonnet-5.5",
        "--critic-provider", "openrouter", "--critic-model", "anthropic/claude-haiku-5.5",
        "--check", "pnpm test", "--max-iterations", "3"
      ],
      "env": {
        "OPENROUTER_API_KEY": "<your key>",
        "PATH": "/usr/local/bin:/usr/bin:/bin"
      },
      "default_mode": "manual"
    }
  }
}
```

- **`PATH`.** It's there for the builder's commands and the check. `/bin/sh -c` reads no shell profile, so a `node` or `pnpm` from nvm, fnm, volta, or asdf has to be on it explicitly.
- **Build first.** Run `pnpm build` before pointing Zed at `dist/cli.js`, because `dist/` isn't rebuilt by anything else.

## Done when

- In Zed, `volley acp` on a scratch repo, in Manual:
  - streams the builder's work as the reply;
  - asks before each edit with its diff, and before each command;
  - runs the check as a command card;
  - shows the critic's verdict as a thought;
  - ends the turn with the summary when the run converges or reaches `--max-iterations`.
- Pressing stop mid-run ends the turn as cancelled. It kills a running command or check, whole process group included, and leaves no stray processes.
- In Auto, uncontained, a command still asks.
- Neither the builder's commands nor the check can read `OPENROUTER_API_KEY`.
- Nothing of volley's own state appears in the repo.
- `volley --builder-provider openrouter --critic-provider openrouter ...` works from the CLI.
- An ACP test drives `volley acp`'s flow through `acp_agent` and the SDK's in-process client. It uses a real engine against a stub model server, the way `test/integration/seat_urls.test.ts` stubs Ollama. A stub engine replaces the whole tool loop, so it never opens a card or asks for approval. The test asserts:
  - the builder's cards;
  - one approval round-trip, allowed and rejected;
  - the check card;
  - the verdict thought;
  - the summary.
- The README documents `volley acp`, the OpenRouter settings, and the Zed snippet.
````

### Planning brief (2026-10-16)

````text
Plan the `volley acp` build from this spec: serve volley as an ACP agent in Zed through fascicle 0.14.0's `fascicle/acp`, with an `openrouter` seat provider. Title: "volley acp: run volley from Zed on OpenRouter". Scope: acp. Size: large.

The spec was revised on 2026-10-16 against what fascicle 0.14.0 actually shipped, and its §6 prerequisites are all met: F1, the check's process-group kill, fascicle 0.14.0, and TypeScript 7. Treat its "What fascicle 0.14.0 gives volley" section as ground truth for the fascicle API. Before settling anything the spec leaves open, read fascicle's own sources in /Users/robmclarty/Projects/fascicle/code/fascicle: docs/acp.md, src/acp/types.ts, and examples/acp-coder/main.ts, the reference coding agent.

Slice it so every step lands green under `pnpm check` and is useful on its own, roughly in this order:
1. The `openrouter` provider (§1), usable from the plain CLI first. Test it against a stub OpenAI-compatible server, the way test/integration/seat_urls.test.ts stubs Ollama.
2. run_volley's new deps (§2): per-seat tools, the builder's on_tool_approval, and a `trajectory` sink tee'd with the file logger. Leaving them out changes nothing.
3. `--state-dir` (§4), on the plain CLI too.
4. The ACP tool sets and prompt variants (§2):
   - the builder gets workspace_tools plus finish;
   - the critic gets the three reads;
   - the prompts name run_command and search.
5. The `volley acp` command (§3):
   - serve_acp with a per-session flow, to_input, and stream routing;
   - the refusals: --worktree, --git, --json, and a claude_cli builder;
   - the seat options lifted out of the run command;
   - @agentclientprotocol/sdk pinned at 1.8.0.
6. Progress in Zed (§3):
   - ctx.emit events from the phases, and a to_updates wrapper for the round lines, the check card, the verdict thought, and the summary message;
   - history rendered with cancelled turns marked.
7. Containment under ACP (§5): the per-command rule, a command_env without the provider keys, and the check run with the same env.
8. The ACP integration test from the spec's done-when:
   - acp_agent plus the SDK's in-process client;
   - a real engine against a stub model server;
   - an approval round trip, allowed and rejected.

   Stub engines never ask for approval, so they can't stand in.
9. README: `volley acp`, the OpenRouter settings, and the Zed snippet.
10. The live Zed check from the done-when, as a human step with a short script like acp-coder's eight-step test.

Constraints to carry as C-items:
- Volley's house style: snake_case, no classes or `this`, errors discriminated by `kind`, `create_engine` only in src/engine.ts, `.js` import extensions, and no loops in flow.ts, phases.ts, or orchestrator.ts.
- Exact dependency pins, within pnpm's 48-hour release-age window; fascicle and checkride are exempt.
- fallow fails on unused exports and dependencies, so each one arrives in the step that first uses it.
- Under `acp`, stdout carries only the protocol.
- The plain CLI's behavior and exit codes stay as they are.
- `pnpm check` gates every step.

Explicitly not doing:
- MCP servers from the client, ACP auth methods, and session/load.
- The `fetch` tool under ACP, and --worktree under ACP.
- OpenRouter cost and reasoning, which are fascicle gaps; `--max-iterations` is the guard.
- Deriving the sandbox allowlist from seat endpoints.
- The native Ollama transport.

Open questions to raise rather than guess:
- Do round lines go to the reply or the thought block?
- Is a claude_cli critic allowed under acp?
- What does `--max-iterations` default to under acp, given no cost cap can trip on OpenRouter?
- Do V6's atomic writes come in with --state-dir, as the spec suggests, or separately?
- Does --state-dir also move `.volley-matrix/`?
````
