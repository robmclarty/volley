# volley — ACP spec (run volley from Zed on OpenRouter models)

A plan-ready specification for serving volley as an Agent Client Protocol (ACP) agent, so it runs from Zed's agent panel on the open repo, with seats on OpenRouter instead of the Claude Code CLI. The fascicle side is drafted as specs in fascicle's `research/` folder and is not built yet.

Add a `volley acp` command that serves volley through fascicle's `serve_acp`, so a prompt in Zed's agent panel starts a volley run on the open repo. The builder's work streams as the reply, the critic's as thoughts, and every edit and command the builder makes goes through Zed's permission prompt. Seats gain an `openrouter` provider, so the whole thing runs on one API key, Claude included, with no Claude Code CLI and no extra SDK.

This depends on fascicle's ACP adapter: [fascicle#13](https://github.com/robmclarty/fascicle/issues/13) (serving a flow over ACP, specified in fascicle's `research/acp-adapter-spec.md`) and fascicle's `research/acp-coding-sessions-spec.md` (workspace tools, permission requests, and modes). Volley is the first fascicle app to run in Zed, and its entry point should be a pattern another fascicle agent can copy.

## Where volley stands (v0.6.1, plus per-seat URLs)

- Seats accept only `claude_cli`, `ollama`, and `lmstudio` (`src/types.ts:16,23`, validated in `src/config.ts:36-56`). No OpenRouter or Anthropic API path exists.
- Each `ollama` or `lmstudio` seat can reach its own server (`builder_url` / `critic_url`, volley#2). A seat's URL resolves from one table, `SEAT_URL_SOURCES` (`src/engine.ts:74`), through `seat_base_url` (`:115`). `create_seat_engines` (`:254`) gives the critic an engine of its own, derived with `with_providers`, only when both seats share a provider at different URLs.
- The tool sets are hard-wired (`src/builder.ts:126-129`, `src/critic/run.ts:87`). Only the engine can be injected into `run_volley` (`src/orchestrator.ts:45-59`), and an injected engine serves both seats. Inside the flow, each seat takes its engine from `FlowDeps.engines` (`src/flow.ts`).
- The builder's `bash` tool is `spawnSync` with a 600 s timeout (`src/builder/tools.ts:451-468`), which blocks the event loop while a command runs.
- `run_volley` calls fascicle's `run` itself, so its model calls don't stream to an outer run. Its `Renderer` does receive every builder and critic chunk (`src/render/renderer.ts:36-46`).
- Each run rotates `.volley/` inside the workspace (`src/workspace.ts:28-37`), and nothing adds it to `.gitignore`.
- A non-CLI critic that hits its step limit while producing its verdict throws `incomplete_generation_error` past the retry and fallback chain, and the run exits 6 (F1 in `research/specs/volley-spec-dependency-followups.md:30`).
- Volley pins fascicle 0.12.13.

## Proposal

### 1. An `openrouter` seat provider

- `--builder-provider openrouter` and `--critic-provider openrouter`, with `OPENROUTER_API_KEY` and an optional `VOLLEY_OPENROUTER_URL`. The engine builds it with `transport: 'native'`, so nothing extra gets installed.
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
- An OpenRouter builder gets volley's own tools, `bash` included, so the containment gate applies to it the way it applies to a local builder.
- Fascicle records OpenRouter costs as missing until the change in fascicle's `research/openrouter-cost-spec.md` lands, so `--max-cost-usd` can't trip on an OpenRouter seat yet. Until then `--max-iterations` is the guard, and `VOLLEY_PRICING_PATH` can supply prices.
- This works from the CLI as well as under ACP.

### 2. Injectable tools and approval

`run_volley`'s deps gain the builder's tools, the critic's tools, and an `on_tool_approval` handler for the builder. Leaving them out keeps today's tools.

Under ACP, the builder gets fascicle's `workspace_tools(session)` plus volley's own `finish` (and `fetch`, if it stays). The critic gets the read-only three: `read_file`, `list_files`, and `search`. The builder's system prompt names its tools (`src/builder.ts:78-82`), so it has to follow the set it's given.

Each seat's engine already reaches the flow through the internal `FlowDeps.engines`, so grow that into per-seat deps (engine, tools, approval) rather than adding parallel fields. `deps.engine` keeps serving both seats, which is how the ACP test injects its one stub engine. Stub engines throw on `with_providers`, and only `create_seat_engines` calls it, on real engines.

### 3. `volley acp`

- A command that calls `serve_acp` with a flow built per session. The flow is one step that runs `run_volley` with `install_signal_handlers: false`, the turn's abort signal, the session's tools and approval handler, and an ACP renderer.
- Each prompt is a fresh run, in place, on `session.cwd`.
  - The prompt is the turn's text, with earlier turns rendered in front of it.
  - The criteria default to the prompt.
  - Everything else comes from the command's flags (`--builder-*` and `--critic-*`, seat URLs included, `--check`, `--max-iterations`), the same as a normal run. Lift the seat options out of the run command (`src/cli.ts:227-234`) so both commands declare them once.
  - `--worktree` and `--git` are refused under `acp` for now, because a sibling worktree sits outside the project Zed has open.
- The ACP renderer forwards `builder_chunk` and `critic_chunk` into the outer run as `model_chunk` events with the step ids `builder` and `critic`. It records them with `ctx.trajectory.record`, the way `model_call` records its own. `serve_acp`'s `stream` option sends `critic` to thoughts. Round and phase changes (build, check, critique) go out as short message lines.
- The turn's final message is the run's summary: whether it converged, how many rounds it took, and the last verdict.
- Nothing writes to stdout but the protocol. The renderer stays on stderr, and `--json` doesn't apply.

### 4. State outside the workspace

Under `acp`, `.volley/` would be rotated in the user's repo on every prompt. Write it under a state directory instead (`--state-dir`, defaulting to somewhere like `$XDG_STATE_HOME/volley/<run_id>`), and offer the same flag in the CLI. The trajectory file stays, so `fascicle-viewer` can follow a run next to Zed.

### 5. Containment under ACP

In Manual and Accept edits, a person approves every command before it runs, which takes the container's place for an interactive session. Auto keeps today's rule: the builder must be contained, or `VOLLEY_ALLOW_UNSANDBOXED_BUILDER` must say otherwise.

The image's network allowlist only reaches the host gateway (`src/sandbox.ts:60-87`), so a contained OpenRouter seat also needs `openrouter.ai` allowed. That matters once volley runs under a headless host such as kandev. Seat URLs meet the same wall: a loopback seat URL crosses to `VOLLEY_MODEL_HOST` on its own port, but a seat on another machine is reachable from inside only through a host port forward. The allowlist could be derived from the seats' resolved endpoints (`seat_base_url`) rather than listed by hand.

### 6. Before the demo

- Fix F1, since with an OpenRouter critic it ends a Zed turn in an error.
- Bump fascicle to the release that ships `fascicle/acp`. Nothing in 0.13.x is marked breaking.

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
      "env": { "OPENROUTER_API_KEY": "<your key>" },
      "default_mode": "manual"
    }
  }
}
```

## Done when

- In Zed, `volley acp` on a scratch repo streams the builder's work, asks before each edit with its diff, runs the check as a command card, shows the critic's verdict as thoughts, and ends the turn with the summary when the run converges or reaches `--max-iterations`.
- Pressing stop mid-run ends the turn as cancelled, kills a running command, and leaves no stray processes.
- Nothing of volley's own state appears in the repo.
- `volley --builder-provider openrouter --critic-provider openrouter ...` works from the CLI.
- An ACP test drives `volley acp`'s flow from an in-process ACP client, with an injected stub engine.
- A non-CLI critic at its step limit no longer exits 6 (F1).
- The README documents `volley acp`, the OpenRouter settings, and the Zed snippet.
