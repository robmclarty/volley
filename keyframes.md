# volley

<!--
Agent draft, 2026-11-02, from the README, the CHANGELOG, research/ and .plumbbob/builds/. The
owner hasn't confirmed any of it yet: keep, change or cut each item, then delete this comment.
Run `npx @robmclarty/keyframes check` after each edit.
-->

## Intent

volley is a CLI harness that runs a builder/critic loop until a task passes both a deterministic
check and a natural-language acceptance review. The builder is an agent with autonomy over a
workspace. The critic is read-only and pluggable, so swapping it changes what the loop optimizes
for: a reviewer drives toward acceptance, an optimizer toward a plateau, a researcher toward
coverage.

It's a personal research harness for studying builder/critic loops, on local models above all, and
it isn't meant for broad use yet. It stands on fascicle for the loop and checkride for the check.
It's opinionated about role separation and nothing else: planning stays inside the builder's own
autonomy.

## Principles

- **P1 (fail-before-spend)**: A run that can't succeed stops at config or preflight, before any
  model call costs money.
  - because: a run is a loop of complete agentic sessions, so it spends faster than anything
    driven by hand.
- **P2 (report-not-refuse)**: When volley can't tell good from bad, it reports what it saw instead
  of refusing it. The operator can opt into refusing a gate edit, but not a degraded verdict.
  - because: a gate edit or a degraded verdict makes a result prove less, not wrong.
- **P3 (partial-is-data)**: A partial result is recorded and carried on, not treated as a failure.
  - because: a run shouldn't die after the builder did good work.
- **P4 (local-first-class)**: A local model is a first-class seat. A change that works on Claude
  but fails a small local model isn't done.
  - because: studying loops on local models is what volley is for.

## Map

- **M1 (cli)**: The ways in: the `volley` CLI and its subcommands, `volley acp` for editors,
  `volley run --protocol runciter.run/1` for a host that speaks runciter's run protocol, config
  resolution, exit codes, the `--dry-run` preflight, live progress on stderr, and the public API
  a parent harness embeds.
  - paths: src/cli.ts, src/acp.ts, src/acp_progress.ts, src/acp_tools.ts, src/config.ts,
    src/exit_codes.ts, src/matrix.ts, src/preflight.ts, src/protocol/, src/render/, src/index.ts,
    src/types.ts
- **M2 (loop)**: One run as a fascicle flow: its topology, the step bodies, the stopping rule,
  cost accounting, each iteration's archive and the run summary, and the flow drawn as a diagram.
  - paths: src/flow.ts, src/phases.ts, src/orchestrator.ts, src/loop_state.ts, src/iteration.ts,
    src/summary.ts, src/cost.ts, src/diagram.ts
- **M3 (builder)**: The builder's session each iteration: Claude Code, or a model driving volley's
  tools, with its presets, history trim and step countdown, and the measure of what it changed.
  - paths: src/builder.ts, src/builder/, src/changes.ts
- **M4 (check)**: The deterministic gate: checkride's structured runner, any shell command, or
  none.
  - paths: src/check/
- **M5 (critic)**: The read-only critic: its presets, prompt composition, tools and
  schema-validated verdict.
  - paths: src/critic/
- **M6 (workspace)**: Where a run's effects land and what a seat can touch: run state, path
  confinement and the shared read tools, per-run git worktrees, the Docker sandbox, which configs
  a resume trusts, and Claude seat permissions.
  - paths: src/workspace.ts, src/workspace_tools.ts, src/worktree.ts, src/sandbox.ts,
    src/containment.ts, src/trust.ts, src/claude_cli_permissions.ts
- **M7 (engine)**: The one seam to fascicle's engine, where provider knowledge stays, and the
  best-effort Ollama pre-load.
  - paths: src/engine.ts, src/prewarm.ts

## Constraints

- **C1 (read-only-critic)**: The critic never writes. It reads and searches the build root, and
  the harness writes `feedback.md` and `verdict` for it.
  - held-by: file:test/unit/claude_cli_permissions.test.ts#"disallows every write and Bash",
    file:test/unit/critic_tools.test.ts#"exposes exactly the three read-only tools"
- **C2 (contained-builder)**: A builder other than `claude_cli`, and a tester on any provider
  but `claude_cli`, runs only inside the sandbox, unless the operator opts out with
  `--allow-unsandboxed-builder`. The all-Claude path never needs Docker.
  - because: a local builder runs a real shell, and the check runs what a tester writes.
  - held-by: file:test/unit/config.test.ts#"refuses a local builder with no opt-out",
    file:test/unit/config.test.ts#"refuses a local tester uncontained and not opted out",
    file:test/unit/preflight.test.ts#"skips the containment checks even when the probes would fail"
- **C3 (no-keys-in-children)**: No process volley starts can read a seat's key,
  `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY`.
  - because: the check runs tests the builder wrote.
  - held-by: file:rules/spawn-sets-env.yml#"id: spawn-sets-env",
    file:test/integration/checkride_gate.test.ts#"runs checkride with the environment it is handed"
- **C4 (claude-arm-unchanged)**: Work on the other seats leaves the `claude_cli` builder arm
  byte-for-byte unchanged.
  - because: runs on different seats are compared, and a change to one arm skews the comparison.
  - held-by: file:test/integration/local_builder.test.ts#"leaves the claude_cli builder arm byte-for-byte unchanged"
- **C5 (machine-stdout)**: stdout carries machine output only, `--json` or the ACP protocol.
  Human progress goes to stderr.
  - held-by: review,
    file:test/integration/acp_cli.test.ts#"exactly one JSON-RPC response on stdout"
- **C6 (stable-exit-codes)**: Each exit code keeps the meaning the README's table gives it.
  - held-by: file:test/unit/exit_codes.test.ts#"maps run statuses to exit codes"
- **C7 (pricing-in-fascicle)**: All pricing knowledge lives in fascicle. volley holds no price
  tables or token math.
  - held-by: file:rules/no-pricing-constants.yml#"id: no-pricing-constants"
- **C8 (one-engine-seam)**: Only `src/engine.ts` creates fascicle's engine. Every other module is
  handed one.
  - because: it keeps the engine mockable in tests and provider knowledge in one place.
  - held-by: file:rules/create-engine-only-in-engine.yml#"id: create-engine-only-in-engine"
- **C9 (flow-owns-iteration)**: Iteration belongs to the flow's fascicle `loop`, with no
  hand-written loops in `src/flow.ts`, `src/phases.ts` or `src/orchestrator.ts`.
  - held-by: file:rules/flow-no-loops.yml#"id: flow-no-loops"
- **C10 (house-style)**: No classes or `this`, named exports only, explicit `.js` import
  extensions, and no reaching past a sibling module's index.
  - held-by: file:rules/no-class.yml#"id: no-class", file:rules/no-this.yml#"id: no-this",
    file:rules/no-default-export.yml#"id: no-default-export",
    file:rules/require-js-extension.yml#"id: require-js-extension",
    file:rules/no-deep-sibling-import.yml#"id: no-deep-sibling-import"
- **C11 (exact-pins)**: Dependencies are pinned exactly, at versions past pnpm's 48-hour
  release-age window. fascicle and checkride are exempt.
  - held-by: file:.npmrc#"save-exact=true", file:pnpm-workspace.yaml#"minimumReleaseAgeExclude"

## Scenarios

- **S1 (converge)**: A builder makes the change, the check passes, the critic approves, and the run
  exits 0.
  - held-by: file:test/integration/happy_path.test.ts#"critic approves -> success"
- **S2 (sent-back)**: The critic sends the work back, and its feedback reaches the next builder's
  prompt, along with a failed check's output.
  - held-by: file:test/integration/happy_path.test.ts#"feeds critic feedback into the next builder prompt",
    file:test/integration/checkride_gate.test.ts#"critic sees the raw slot"
- **S3 (cost-cap)**: With `--max-cost-usd` set, a run that crosses the cap stops with exit 7, and
  the iteration it was in stays intact.
  - held-by: file:test/integration/budget_and_cap.test.ts#"builder crossing the cap skips check and critic",
    file:test/integration/budget_and_cap.test.ts#"stops the loop with the iteration intact"
- **S4 (local-builder)**: A local model on Ollama builds through volley's own tools, and work cut
  off at its step cap still goes to check and critic.
  - held-by: file:test/integration/local_builder.test.ts#"treats a max_steps cutoff as data"
- **S5 (resume)**: An interrupted run resumes with its feedback and totals carried over.
  - held-by: file:test/integration/resume.test.ts#"continues after an interrupted iteration with feedback and totals carried"
- **S6 (zed)**: In Zed, `volley acp` runs each prompt as a fresh run, asks before each edit and
  command, and ends the turn with the summary.
  - held-by: file:test/integration/acp_turn.test.ts#"lands the allowed edit"
- **S7 (critique)**: `volley critique` reviews a change already made, asking only the critic.
  - held-by: file:test/integration/critique_cli.test.ts#"with only the critic asked"
- **S8 (worktree)**: Under `--worktree`, the builder runs in a per-run worktree that's torn down
  when the run ends.
  - held-by: file:test/integration/worktree.test.ts#"wraps the builder loop in a per-run worktree and tears it down after"

## Decisions

- **D1 (two-substrates)**: Build on fascicle (the loop, providers, cost and trajectories) and
  checkride (the check), pinned to the versions volley is tested against.
  - because: volley's own opinion is role separation, and the rest belongs to its substrates.
- **D2 (fresh-context)**: Every builder and critic call is a fresh session. Only the workspace,
  the critic's feedback and a failed check's output carry between iterations.
  - because: it makes each iteration independently reproducible and debuggable.
- **D3 (pluggable-critic)**: The critic is a system prompt: `reviewer` (the default),
  `optimizer`, `researcher`, or a path to your own.
  - because: same harness, different objective function.
- **D4 (harness-writes-verdict)**: The critic returns a schema-validated
  `{ verdict, feedback, unmet_criteria }`, and the harness writes `feedback.md` and `verdict`
  from it.
  - because: then the critic can't get them wrong.
- **D5 (gate-edits-reported)**: A builder's edit to the gate (tests, fixtures, check config) is
  reported by default, and refused only under `--fail-on-gate-edit`, with exit 8.
  - because: plenty of tasks are about the tests, and a gate edit makes a green check prove less,
    not wrong.
- **D6 (cap-between-phases)**: The loop guard checks the cost cap after each phase. No session is
  killed mid-flight for cost.
  - because: a builder killed mid-edit leaves the workspace undefined.
- **D7 (checkride-auto)**: `--check auto` finds checkride and gates on its summary. Any shell
  command, or `none`, works too.
  - because: checkride's raw per-tool output goes straight to the critic.
- **D8 (local-tool-loop)**: A local builder gets volley's own tools and one bounded tool loop per
  iteration, making one change or command per turn by default.
  - because: a local model brings no tools, and some model and runtime pairs return parallel
    calls badly.
- **D9 (critic-ladder)**: A critic on any provider but `claude_cli` retries once after a stream
  death, then judges without tools, and that verdict is marked degraded.
  - because: a fragile local critic was killing runs after the builder had done good work.
- **D10 (state-dir)**: `--state-dir` keeps each run at `<root>/<run_id>/`, outside the workspace.
  Without it, the CLI keeps `<workspace>/.volley/`, and `volley acp` defaults to the XDG state
  root.
  - because: a per-run directory never needs rotating, and under acp nothing of volley's should
    appear in the repo.
- **D11 (acp-asks)**: Under `volley acp`, uncontained and not opted out, every builder command and
  every check asks first. A `claude_cli` builder is refused there.
  - because: volley's own tools never ask, and the Claude CLI's permissions bypass Zed's prompts.
- **D12 (v0-no-promises)**: While volley is v0.x, flags, the config shape and `--json` output
  change without notice.
  - because: it's a personal research harness, not a product.

## Taste

- **T1 (snake-case)**: snake_case for values, functions and file names, PascalCase for types.
- **T2 (errors-say-next)**: An error names what to check or what to try, such as the variable
  that's unset.
- **T3 (why-comments)**: Each module opens with a doc comment that says why it exists, citing the
  run or issue that showed the need.
- **T4 (truthful-docs)**: The README says what's true today, limits included. The CHANGELOG says
  what changed and why, in full sentences.

## Questions

- **Q1 (bare-mode)**: Once `claude -p` defaults to `--bare`, how do subscription seats keep
  authenticating? Tracked as volley#9, and waiting on fascicle.

## Ideas

From `research/agent-native-upgrades.md`, none built yet:

- **I1 (required-findings)**: Findings the builder must answer, split into required and optional,
  with the loop stopping once nothing changes.
- **I2 (checked-evidence)**: Critic verdicts backed by checked evidence, with the critic's tool
  calls kept in the archive.
- **I3 (instructions-are-gate)**: Count agent-instruction files, such as `AGENTS.md`, as gate
  files.
- **I4 (loop-breaker)**: A loop breaker for local builders.
- **I5 (atomic-writes)**: Atomic `.volley/` writes, so a crash can't tear a summary that
  `volley resume` reads back.
