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
- **The check.** It runs through an async `spawn` with its output captured (`src/check/checkride.ts:47`), so nothing reaches stdout. An abort kills only `sh`, not the check's process group, so a stopped `pnpm test` can leave its workers running.
- **State.** Each run rotates `.volley/` inside the workspace (`src/workspace.ts:28-37`), and nothing adds it to `.gitignore`.
- **F1.** A non-CLI critic that hits its step limit while producing its verdict throws `incomplete_generation_error` past the retry and fallback chain, and the run exits 6 (F1 in `research/specs/volley-spec-dependency-followups.md:30`).
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

### 6. Before the demo

- Fix F1, since with an OpenRouter critic it ends a Zed turn in an error.
- Add `@agentclientprotocol/sdk` to volley's dependencies with an exact pin, in the change that first imports `fascicle/acp`; until then the dead-code check would flag it. 1.8.0 clears pnpm's two-day release-age window, and 1.9.0 was published on 2026-10-16. (fascicle itself is already on 0.14.0.)
- Kill the check's whole process group on abort, the way `run_command` does: spawn it detached, and on abort kill the negative pid. Then a stop mid-check leaves no test workers behind.

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
- A non-CLI critic at its step limit no longer exits 6 (F1).
- The README documents `volley acp`, the OpenRouter settings, and the Zed snippet.
