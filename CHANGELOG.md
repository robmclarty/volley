# Changelog

## v0.10.0 — 2026-10-27

### Added
- **A builder sees what the last check said (#6).** When the previous iteration's check failed, the builder's prompt carries a `PREVIOUS CHECK RESULT` section: the exit code, the failing slots, and an excerpt capped at 6,000 characters, taken from checkride's digest (volley now runs `pnpm exec checkride --json --digest` and archives `check/digest.md`), else the start of each failing slot's raw output, else the end of a command's output. A resume rebuilds it from the archive, and a check the user rejected under `volley acp` reads as never having run, not as failed.
- **A tool-loop builder's last steps count down (#6).** The last five steps of a session, or a tenth of a longer budget, end with a note of how many are left and the command that runs the check, and the last says that only `finish` runs on it. When a session hits its step limit, the next prompt says so and asks for the check first.
- **`--builder-max-output-tokens <n>` caps a tool-loop builder's output per turn (#6).** Or `VOLLEY_BUILDER_MAX_OUTPUT_TOKENS`. Reasoning counts, and Ollama gets it as `num_predict`. An ollama or lmstudio builder is capped at 16,384 by default, an openrouter one only when you set a cap. A turn cut off before it calls a tool costs that step instead of ending the session, and each iteration's summary counts those turns as `builder.truncated_turns`.
- **`builder_max_steps_hits` counts the builder sessions that ran out of steps (#6).** It's on `RunResult`, so `--json` and `summary.json` carry it, since the warning each one prints goes to stderr, which `--json` silences.

### Changed
- **Reads don't count against `--builder-max-tool-calls` (#6).** `read_file`, `search_files`, and `list_files` are read-only, so a builder that batches them gets them all, and past the cap the next request names the calls that were dropped. Above a cap of one, step 2 of the builder's prompt no longer names the cap.
- **The builder is asked to check as it goes (#6).** In a checkride workspace it's told to run `pnpm exec checkride --digest` after each batch of edits and to read `.check/digest.md` before any slot's raw output, and both harness prompts say to verify after each batch of edits, not only before finishing.
- **`RunResult` has `builder_max_steps_hits` and `ResolvedConfig` has `builder_max_output_tokens`.** Both are required, so SDK code that builds either by hand needs them.

### Fixed
- **A contained `--worktree` run keeps its work.** The sandbox image has no git identity, so volley's own commits failed inside it: the salvage commit that keeps a converged run's work on `volley/<run id>`, the `--git` checkpoints, and the squash merge. They now fall back to `volley <volley@volley.invalid>` for whatever git lacks, and an identity you configured still wins.
- **A failing slot's raw output is read only from inside the check directory.** Slot names and output files come from a summary the builder could have written, and a `../` in one could put a file from outside it in front of the critic or the next builder.

### Internal
- **Built on fascicle 0.17.1**, which names a turn's dropped tool calls to the model and can go on past a turn cut off at its output cap.
- **The publish workflow keeps its OIDC identity out of the job that runs dependencies.** A `build` job verifies the tag, installs, runs the gate, builds, and packs with read-only permissions, and a separate `publish` job holds `id-token: write` behind the `npm-publish` approval and publishes that tarball with `--ignore-scripts`.
- **The tests drive the step countdown, the per-turn cap's read-only reads, and the output cap through fascicle's real tool loop**, against a stand-in OpenAI server that now takes several calls a turn and can end one on `length`.

## v0.9.0 — 2026-10-20

### Added
- **`volley critique` checks and critiques a change already made, once, with no builder (#3).** The change is everything that differs from `--baseline` (default HEAD), committed or not, untracked files included, and the critic sees what a run's critic sees, so critics can be compared on fixed, known-good and known-bad changes without paying for builder turns. It exits 0 on approval over a green check and 2 when the critic asks for changes or the check is red (status `rejected`). Every builder or loop flag, and `--config`, is refused by name (exit 5), and a `--baseline` that isn't a commit fails before any state is written. `run_critique` is exported for harnesses.
- **`--builder-max-tool-calls <n>` lets a tool-loop builder make several tool calls a turn (#4).** Or `VOLLEY_BUILDER_MAX_TOOL_CALLS`; the default stays 1, since some model and runtime pairs return parallel calls badly. Above 1, the builder's prompt asks it to batch independent reads but make one change or command per turn. The cap is recorded with the run and kept on resume.
- **Each run names its state directory.** `RunResult`, and so `--json` and `summary.json`, carry `run_state_dir`, and a run prints `state: <dir>` when it starts and in its final summary. `--dry-run` names the state root.
- **`sandbox_run_args` mounts a contained run's own state directory.** Its `run_state` option binds the host's `<root>/<run id>/` at that run's directory under `SANDBOX_STATE_ROOT`, never the whole root, so the builder inside can't read or rewrite another run's state. `default_state_root` and `SANDBOX_STATE_ROOT` are exported.

### Changed
- **Run state leaves the workspace by default (#5).** Without `--state-dir`, a run's config, summary, trajectory, feedback, verdict, and iterations go to `<root>/<run id>/`, where the root is `$XDG_STATE_HOME/volley`, else `~/.local/state/volley`, as under `volley acp`. A check that reads every file, dot-directories included, no longer fails from the second iteration on over volley's own feedback. A harness that read `<workspace>/.volley/` reads `run_state_dir` instead. A run directory volley can't write is a configuration error (exit 5), and inside the sandbox the message names the mount. The critic's "prior iteration state" line now drops by default, since the iterations sit outside the tree it reads.
- **`volley resume <id>` finds a run from any directory**, under `--state-dir` or the default root, and falls back to the workspace's `.volley/` for a run an older volley started. It refuses a run directory with a symbolic link in it, an id that isn't a run id, and a critique, which has nothing to resume.
- **A resume on the host runs only a config this machine signed.** volley signs each run's `config.json` (as `config.sig`) under a key kept at `$XDG_CONFIG_HOME/volley/run-key`, else `~/.config/volley/run-key`, and signs nothing inside the sandbox, so a contained run's builder can't plant a check or seat for a host-side resume to run. A config without a valid signature (a contained run's, another machine's, an older volley's, or one edited by hand) resumes only with `--trust-config`, which first shows the check and seats it's about to run, escaped so a planted control sequence can't disguise them. Resume a contained run inside its container.
- **`ResolvedConfig` has `mode` and `builder_max_tool_calls`, and `RunResult` has `mode` and `run_state_dir`.** All are required, so SDK code that builds either by hand needs them. `resolve_config` always sets `state_dir`, where null still means the workspace's `.volley/`. `RunStatus` gains `rejected`, and a critique's `comparison.builder_transport` is null.

### Fixed
- **`search_files` and `list_files` on a file path search or list that file.** They walked it as a directory and answered "no matches", which led a local critic to reject a sound change. A path that doesn't exist now says so.
- **A critic verdict with null `feedback` or `unmet_criteria` reads as empty.** A critic that holds tools isn't constrain-decoded, and such an answer failed schema validation and exited 6.
- **A `--state-dir` inside the workspace stays out of the builder's work.** Its files showed up in the change list the critic reads and were committed by `--git` checkpoints. A `--state-dir` that is the workspace itself is refused (exit 5).

### Internal
- **The tests keep run state and the signing key out of your home directory.** A setup file gives each test file its own `XDG_STATE_HOME` and `XDG_CONFIG_HOME`, and fails a file that leaves a test run in the real state root or makes the real key.

## v0.8.0 — 2026-10-19

### Added
- **`volley acp` runs volley from Zed.** It serves volley over stdio as an Agent Client Protocol agent, so Zed's agent panel, or any ACP client, can drive it. Each prompt is a fresh volley run on the open project. The builder's work streams in as the reply under a **Round N** line, the check runs as a command card, the critic's verdict shows as a thought, and the turn ends with a summary. Edits and commands go through the editor's permission prompts. Outside volley's sandbox container, every builder command and every check asks first, Auto mode isn't offered, and neither the commands nor the check can read `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY`. Run state goes under `$XDG_STATE_HOME/volley`, never the repo. It requires the four seat flags and refuses `--worktree`, `--git`, `--json`, and a `claude_cli` builder (exit 5). The README covers the Zed setup and a check to run by hand.
- **Either seat can run on OpenRouter.** `--builder-provider openrouter` and `--critic-provider openrouter` reach a hosted model with one `OPENROUTER_API_KEY`, from the plain CLI as well as `volley acp`, and `VOLLEY_OPENROUTER_URL` overrides the endpoint. An OpenRouter builder runs volley's own tool loop under the same containment gate as a local one, and an OpenRouter critic gets the local critic's retry and fallback. OpenRouter reports its own charge, so `--max-cost-usd` trips on it. An unset key is a configuration error (exit 5).
- **`--state-dir <root>` keeps run state out of the workspace.** Each run's state goes to `<root>/<run_id>/`, and `state_dir` in a config file does the same. `volley resume <id> --state-dir <root>` finds a run there. Without the flag, state stays in `.volley/` as before.
- **`run_volley` takes per-seat tools, a builder approval handler, and a trajectory sink.** All three are optional, and a run without them is exactly what it was.

### Changed
- **`ResolvedConfig` has `state_dir`.** It's required (`string | null`), so SDK code that builds a `ResolvedConfig` by hand instead of through `resolve_config` needs it. Null keeps the run's state in `.volley/`.

### Fixed
- **A local critic that runs out of steps falls back instead of failing the run.** Since fascicle 0.10.1, a critic that spent its step budget reading files threw straight past the retry and the fallback, so the run exited 6, and `--dry-run`'s canary exited 5. It now goes straight to judging without tools. A fallback verdict now says why: `degrade_cause` (`stream_error` or `step_exhaustion`) on the critic record, `critic_degrade_causes` in the summary's comparison block, and `deg:stream` or `deg:steps` in the matrix flags.
- **Stopping a run mid-check now stops the whole check.** A stop killed only the check's shell, which left a test runner's workers, or a server the check started in the background, still running. The check now runs in a process group of its own, and a stop kills all of it.

### Internal
- **Built on fascicle 0.16.3 and @agentclientprotocol/sdk 1.8.0.**
- **The tests drive a whole volley turn through an in-process ACP client**, against a stub model server. The live check in Zed is scripted in the README and was run by hand. Its one miss, the check's card losing its command look while it asks, waits on robmclarty/fascicle#16.
- **The flow diagram's critic retry and fallback rows name every provider but `claude_cli`.**

## v0.7.0 — 2026-10-16

### Added
- **Each seat can use its own model server.** `--builder-url` and `--critic-url` (`builder_url` and `critic_url` in a config file) point the builder and the critic at different machines even when both run on the same provider, such as two Ollama servers. A seat without a URL of its own uses the provider's env var (`VOLLEY_OLLAMA_URL` or `VOLLEY_LMSTUDIO_URL`), then the default, never the other seat's. Everything a seat sends goes to its URL: its model calls, the Ollama prewarm and context check, and the `--dry-run` probe and critic canary. Inside the sandbox, a loopback seat URL crosses to `VOLLEY_MODEL_HOST` on its own port. Both URLs carry over to `volley resume` and to every `volley matrix` pairing. A URL on a `claude_cli` seat, or one that isn't plain http(s), is a configuration error (exit 5).

### Changed
- **Ollama seats need ai-sdk-ollama 4.3.0 or later.** Before 4.3.0 it streams a thinking model's reasoning only when a request sets `think`, which volley never does, so the reasoning vanished from the terminal and the trajectory and the phase's throughput read high. volley now declares the floor as an optional peer: pnpm warns about an older copy, npm refuses it with ERESOLVE, and an install without ai-sdk-ollama is unaffected.
- **`--dry-run` probes the critic's model endpoint too.** Each local seat's endpoint is probed, once for a server both seats share, so a `claude_cli` builder with a local critic now gets a reachability check before the canary, and an unreachable endpoint is named with its seat.
- **`ResolvedConfig` has `builder_url` and `critic_url`.** Both are required (`string | null`), so SDK code that builds a `ResolvedConfig` by hand instead of through `resolve_config` needs them. A run saved by an earlier version resumes with both null.
- **An empty `VOLLEY_OLLAMA_URL` or `VOLLEY_LMSTUDIO_URL` means the default.** It used to fail the run with a configuration error.

### Fixed
- **An IPv6 loopback model URL reaches the host from inside the sandbox.** `http://[::1]:…` was never crossed to `VOLLEY_MODEL_HOST`, because `URL` keeps the brackets in the hostname.

### Internal
- **Built on fascicle 0.14.0, TypeScript 7, and tsdown.** tsdown replaces tsup, whose declaration build needed a compiler API TypeScript 7 no longer exports. The published files keep their names and exports, and the bundles now keep their source comments. The dev toolchain moves to checkride 0.14.0, fallow 3.33.1, oxlint 1.88.0, vitest 5.0.4, and @ast-grep/cli 0.50.0, alongside ai 7.0.140, undici 8.12.1, and cac 7.1.0, and `pnpm audit` is clean.
- **The throughput docs mark the gap that remains on Ollama.** A turn whose only output is a tool call still reports a rate far too high until fascicle times those turns another way (robmclarty/fascicle#12).
- **An integration test holds each seat to its own server.** It runs real engines against two stand-in Ollama servers, and the local-provider tests no longer reach a developer's own Ollama.

## v0.6.1 — 2026-10-14

### Fixed
- **`--worktree` now isolates a Claude builder.** The `claude` session started in the workspace instead of the worktree, so under `--worktree` a `claude_cli` builder edited your checkout while the check, the checkpoints, and the change report the critic reads all looked at the untouched worktree. Claude sessions now start in the worktree; `.volley/` run state stays in the workspace as before, and local-model builders, whose tools were already rooted in the worktree, are unaffected.

### Internal
- An integration test runs the real engine against a stand-in `claude` binary and checks that the builder's write lands on the run branch, not in the workspace.

## v0.6.0 — 2026-09-27

### Added
- **The container spec is exported from the package root.** `sandbox_run_args`, `network_run_args`, `SANDBOX_NETWORK_NAME`, `SANDBOX_NETWORK_SUBNET`, and the `SandboxNetwork` type are now public, so a harness that launches volley's container renders volley's own hardened `docker run` flags instead of a copy that drifts from them. `sandbox_run_args` gains `labels` (one `--label KEY=VALUE` each, so a caller can find and reap its containers), and `store_volume` is now optional: leave it out and no pnpm store is mounted.
- **`--run-id <id>` names a run.** The id names the run's `.volley/` state and its `volley/<id>` branch in place of a fresh UUID, so a harness that owns the id finds the run in both. Ids are limited to letters, digits, `-`, and `_`, starting with a letter or digit; anything else is a config error before any spend, and the CLI refuses a bare-number id rather than silently dropping its leading zeros.

### Fixed
- **Runs started from the SDK run their check.** `resolve_config` now resolves the check the way the CLI always did. It used to return `'none'` for every config, so an embedded run ran no check even with `check: 'auto'` in a checkride workspace or with a command check.

### Internal
- The version skill bumps `package.json` after writing the changelog, so pnpm's clean-tree check no longer blocks it.

## v0.5.4 — 2026-09-25

### Added
- **A diagram of the loop, drawn from the code.** The README's new "The flow" section shows the real composition: the branch that skips verification once the builder alone crosses the cost cap, the critic's retry-then-tool-less fallback for local models, and the guard that stops the loop. fascicle's `describe.diagram` renders it from `src/flow.ts`, and `pnpm diagram` prints it from a checkout.

### Changed
- **The trajectory's flow structure includes the builder and the critic.** They now appear as children of `build` and `critique` in the tree a run records at its start, so the fascicle viewer draws both model calls, and the critic's retry and fallback, before the run reaches them. Live output, verdicts, and exit codes are unchanged.

### Internal
- Built on fascicle 0.12.13. A test holds the `src/flow.ts` header diagram and the README's copy to `describe.diagram`, so neither can drift from the code.

## v0.5.3 — 2026-09-24

### Fixed
- **Local phases report a true decode rate.** The `throughput` block for Ollama and LM Studio builder and critic phases was labeled `basis: 'decode'` but still counted prompt prefill, because fascicle started the clock on the stream's opening framing rather than the first token. Rates now exclude prefill and read higher than the ones v0.5.2 archived; `claude_cli` rates are unchanged.

### Changed
- **A local stream that dies before its first token is retried by the engine.** fascicle now treats that failure as retryable on the ai_sdk transport, as it already did on native, so some local-critic stream deaths are absorbed before volley's critic retry and tool-less fallback see them.

### Internal
- Built on fascicle 0.12.10.

## v0.5.2 — 2026-09-24

### Added
- **Tokens per second for each phase.** The iteration archive (and `PhaseRecord`) gains a `throughput` block for the builder and the critic: the rate, whether it is a pure decode rate or blended with network and prefill, the output tokens, and the model's own time. `claude_cli` phases get a blended rate from the CLI's reported API time, so local models and Claude compare on speed as well as on iterations and cost.

### Changed
- **One clock for every provider's phase durations.** `duration_ms` in the iteration archive is the measured wall clock of the builder's whole call and of the critic's whole retry-then-fallback sequence, failed attempts included. `claude_cli` phases used to report the CLI's own figure; they now include its startup time and compare directly with local phases.
- **The trajectory shows the model calls as steps of their own.** The builder, the critic, and the critic's retry and tool-less fallback now appear nested under `build` and `critique`, so the fascicle viewer shows where a local critic retried or fell back. Live output, verdicts, and exit codes are unchanged.
- **Stray arguments are rejected.** `volley bogus` now exits 3 with "Unused args" instead of silently ignoring the extra argument.

### Fixed
- **Local phases no longer archive a duration of 0.** Every Ollama and LM Studio builder and critic phase recorded `duration_ms: 0`, because the duration was only ever read from what the `claude` CLI reports.
- **undici 8.11.0** closes GHSA-4cwx-7wf7-3272.

### Internal
- Built on fascicle 0.12.9 (up from 0.9.5), checkride 0.13.0, vitest 5, and TypeScript 6. The run's topology now lives in `src/flow.ts` under a diagram of the flow, with the step bodies in `src/phases.ts` and the stopping rules in `src/loop_state.ts`; `gate`, `initial_state`, and `status_of` are still exported from the package root.
- The check gate adds fallow's duplication slot, and exports nothing outside their module used are gone.
- Pushing a `vX.Y.Z` tag publishes to npm through trusted publishing with provenance and cuts a GitHub Release, and `CHANGELOG.md` now ships in the npm tarball.

## v0.5.1 — 2026-09-16

### Changed
- **Published as `@robmclarty/volley`** — the bare `volley` name on npm belongs to an unrelated project. The binary is still `volley`; config files import `VolleyConfig` from the scoped name.
- **License is Apache-2.0**, with the license file now in the tree, matching fascicle, checkride, plumbbob, and ridgeline; the manifest had said MIT and shipped no license text.
- **README corrections.** Anthropic paused its programmatic-billing change on 2026-06-15 rather than shipping it, so the cost-cap section no longer claims subscription runs are metered; the trajectory viewer is named by the bin fascicle actually ships; ridgeline is linked.

### Added
- A README **Status** section saying what this is — a personal research harness at v0.x with pinned substrates and no support commitment — and where the design record lives.
- **GitHub Actions CI**: the full checkride gate plus a build on every push to `main` and every pull request.

### Internal
- Public-facing docs, code comments, and test names no longer cite spec decisions by their internal ids. The specs under `research/` and the build logs under `.plumbbob/` remain the decision record, ids included.
- The `/version` release skill no longer claims volley has no remote. It still marks a release with a bare `vX.Y.Z` commit and leaves pushing to the operator, and its verify note names the current checkride slots.

## v0.5.0 — 2026-09-16

### Changed
- **`volley matrix` row and run-state shapes.** A row is now a seat aggregated over its attempts (`runs`, `converged`, `mean_iterations`, `mean_wall_clock_ms`, `mean_cost_usd`, `reason`, plus every `attempt`) rather than one run's fields, and per-attempt state moved from `.volley-matrix/<builder>__<critic>/summary.json` to `…/run-NN/summary.json`. Both `--json` consumers and on-disk readers of the v0.4.1 layout need updating.

### Added
- **volley sees what the builder changed, and says so.** Every iteration now diffs the build root against a baseline captured before the first iteration, and hands the result to the two places that were flying blind. The **critic prompt** carries the changed-path list, so a critic reviews a change instead of re-reading a tree the deterministic check already blessed (paths and statuses only — never diff hunks, so a 32k-context local critic's prompt stays bounded). The **run summary** gains `comparison.gate_edits`, and each iteration archive carries its own change set.
- **`volley matrix --repeat N`.** Each seat now runs N times (default 1) and the row reports a pass *rate* over those attempts, because one run is the only thing n=1 can honestly report on: local runs are stochastic, so a single sample supports a hard failure and nothing else — not iterations-to-converge, not wall clock. Each aggregate names the population it is over: `iters` averages the converged attempts only, `wall` and `cost` average every attempt that reported one, and salvage is a ratio of totals rather than a mean of ratios. Every attempt's run state is kept (`.volley-matrix/<builder>__<critic>/run-NN/summary.json`), and the whole sweep is written to `.volley-matrix/matrix.json`.
- **The matrix table says *why* a seat fell off.** `budget_exhausted` is a status, not a diagnosis. A row's new `why` column names the failing check slots, the criteria the critic still judged unmet, a cost cap, a gate edit, or the error that broke the run; `flags` separates what qualifies a pass (`deg` for a degraded critic, `gate` for a builder that edited the gate) from what explains a failure. Mean cost per run joins the table, and every attempt's full detail — status, verdict, failing slots, unmet criteria, gate edits — is in the `--json` aggregate.
- **`comparison.unmet_criteria` in the run summary**: what the critic still judged unmet when the run stopped, verbatim, so a non-converged run says what it was missing rather than only that it stopped. Archived per iteration too.
- **Gate-edit detection.** Changed paths matching the *gate* — the tests, fixtures, and check configuration that decide whether the work passes — are called out to the critic, warned about on stderr, and recorded in the summary. This mechanizes the by-hand verification `research/reckon-local-run-finding.md` recommends making routine: a green check plus an empty `gate_edits` is worth more than a green check alone, because a builder can also pass by editing the test. Reported, not refused, by default (plenty of tasks are legitimately about the tests); `--fail-on-gate-edit` halts the run with the new **exit 8** instead, and beats success rather than losing to it. `--gate-paths` / `gate_paths` replaces the built-in pattern list, and `--dry-run` predicts the posture — including a warning that the refusal cannot fire outside a git repository.

### Fixed
- **`volley --version` reports the real version.** It was a literal in `src/cli.ts`, frozen at `0.2.0` since v0.2 while `pnpm version` bumped only `package.json`; it now reads the manifest at startup, so it cannot drift from a release again. The fixing commit filed this under v0.4.1 below, but it landed after that release; v0.5.0 is the first version that ships it.

### Internal
- `research/reckon-local-run-finding.md`: the first multi-module, all-local run finding — four modules with a real dependency order and a `node --test` gate — and the by-hand verification that gate-edit detection now automates.
- Change-detection tests pin the `--worktree` seam (the diff runs against the worktree, not the workspace) and the exact promise the gate-edit warning makes; preflight tests cover the `--dry-run` gate-edit posture line.

## v0.4.1 — 2026-07-24

### Added
- **`volley matrix`**: sweep builder×critic model combos serially over one otherwise-fixed config and aggregate every run's `comparison` block into a single table (per-combo state under `.volley-matrix/<builder>__<critic>/summary.json`; `--json` for the aggregate). Serial by design — the local providers share one GPU, so parallel combos would thrash the model loader. A combo that runs without converging is a *result* row; the sweep exits nonzero only when a combo yields no summary at all.
- **Critic-seat canary in `--dry-run`**: for a local critic, one tiny $0 generate through the real critic tool wiring before any builder spend. A degradable death warns and predicts `critic_degraded`; only a would-fail-even-degraded combo exits 5, named model×seat. The `claude_cli` critic path never runs it.
- **`--discard-worktree`**: throw a `--worktree` run's effects away at teardown instead of keeping them on the run branch — "isolate the effects, I only want the verdicts". `volley matrix` forces it for every seat, so a sweep leaves neither a branch nor a squash commit per combo. Refused without `--worktree`; `--git` still wins, so `--worktree --git` integrates exactly as before.
- **Two example families for probing a local model's real ceiling**: `examples/essayist` (a non-code task with a custom critic prompt, rubric, and JS check gate) and `examples/ladder` (seven capability rungs from greenfield through brownfield bugfix and cross-file refactor, plus an online-only dependency-wrangling run recipe).
- An upstream-ready write-up of the Ollama qwen tool-call parser failure that kills `qwen3.6` in the critic seat (`research/ollama-qwen-parser-issue.md`).

### Changed
- **A local critic now degrades instead of dying.** A provider stream error is retried once (recorded on the critic record as `retries` / `retry_cause_kind`), and a critique that keeps dying with tools attached falls back to a tool-less verdict grounded in the criteria, the raw check artifacts, and a workspace file inventory. A fallback verdict is *always* marked `critic_degraded` — in the iteration summary, the run's `comparison` block, and the matrix table — so a shallower critique never passes silently as a full one.

### Fixed
- **`volley --version` reports the real version.** It was a literal in `src/cli.ts`, frozen at `0.2.0` since v0.2 while `pnpm version` bumped only `package.json`; it now reads the manifest at startup (from `src/` under tsx and from `dist/` in the published package alike), so it cannot drift from a release again.
- **`--worktree` without `--git` no longer destroys a successful run's work.** With `worktree: true` and git checkpoints off (the default), a fully green run — check passed, critic approved — ended in `git branch -D` plus a forced worktree removal: the builder's uncommitted work deleted, the workspace untouched, nothing said before or after. Teardown now *salvages* that case instead — it commits the worktree's state onto the run branch (`volley/<run id>`), keeps the branch, removes only the checkout, and reports the branch as `salvaged_branch` in `.volley/summary.json` and `--json` output, so the work is recoverable with `git switch` / `git cherry-pick`. If the salvage commit itself cannot land (no git identity, a stale index lock), the checkout is left standing rather than deleted. Runs that did not converge, and `--worktree --git` runs whose work was squash-merged, still discard wholesale; the documented integrate path is unchanged.
- **A `--worktree` run's fate is now predicted before any model spend.** `--dry-run` and run start each print one line saying what a successful run will do with its effects — squash-merge onto the workspace branch (`--git`), leave them on the run branch (`--worktree` alone; a warning, since nothing is integrated), or throw them away (`--discard-worktree`) — alongside the existing critic-seat canary and `num_ctx` predictions.

### Internal
- README refreshed to v0.4.0 truth, and the matrix example's `--config` path corrected.

## v0.4.0 — 2026-07-17

### Added
- **Sandboxed local builds.** A local-model builder now runs as the whole volley process inside one hardened Docker container that volley *detects* it is inside (the `VOLLEY_CONTAINED=1` marker its image bakes in — volley does not start the container itself) over a per-run git worktree (`--worktree`) — its effects land on a throwaway phase branch and squash-merge onto the workspace only on a successful `--worktree --git` run. Ships a default image and `Dockerfile` (`--sandbox-image` / `VOLLEY_SANDBOX_IMAGE` to override), default-deny network egress with a host-gateway allowlist, and a `--dry-run` preflight that verifies the toolchain, worktree, and host LLM endpoint before any model spend (exit 5 on failure). `claude_cli` builds stay on the host, Docker-free.
- **v3 comparison examples.** `examples/all-claude` and `examples/all-local` run an identical task, criteria, check gate, and caps so their `.volley/summary.json` `comparison` block (iterations-to-converge, wall-clock, cost, verdict, check trajectory, local salvage rate, transport) isolates model-vs-transport; the finding is written up under `research/`.

### Changed
- **Upgraded to fascicle 0.9.5 on AI SDK v7** (`ai@^7`, `ai-sdk-ollama@^4`), moving the local-provider peer set forward together on the `ai_sdk` transport (the native Ollama transport is documented as a one-line future flip). Resolves the v0.3.1 local-builder peer-major mismatch by construction.
- **A require-containment gate for local builders:** a local builder is admitted only when volley detects it is running inside its container (`VOLLEY_CONTAINED=1`) or `--allow-unsandboxed-builder` (`VOLLEY_ALLOW_UNSANDBOXED_BUILDER=1`) is set; `claude_cli` is exempt. A *contained* `claude_cli` role must use API-key auth (`VOLLEY_AUTH_MODE=api_key`) — its subscription/OAuth token does not survive containerization.
- Upgraded checkride 0.2.1 → 0.4.1 (atomic summary writes, stale-artifact clearing, and a `checks_run` vacuous-green signal).

### Fixed
- `checkride --json` parsing now tolerates pnpm 11's dep-verify line printed ahead of the JSON, with a `.check/summary.json` fallback — the check no longer dies with "unparseable stdout."

### Internal
- oxlint-tsgolint bumped to 0.22.1 to satisfy oxlint's peer floor.

## v0.3.1 — 2026-07-10

### Fixed
- The default Ollama base URL is now the server root (`http://localhost:11434`):
  the previous `…/api` default made `ai-sdk-ollama` (which appends `/api/…`
  itself) request `/api/api/chat` and 404 on every call, breaking both local
  roles out of the box. A trailing `/api` on `VOLLEY_OLLAMA_URL` is stripped
  for compatibility with the old documented value.
- Pre-load an Ollama model at builder start (and before a local critic's first
  verdict): a cold multi-GB model load could exceed the provider's in-request
  first-byte timeout and kill the run minutes in with an opaque
  `stream interrupted: fetch failed`.
- Document that the `ai-sdk-ollama` peer must match fascicle's declared major
  (`^3` today — a bare `pnpm add ai-sdk-ollama` pulls v4, which targets a newer
  AI SDK spec and hard-fails at the first call), and ship it as a devDependency
  so the local live smoke test runs from a fresh checkout.

### Internal
- Name every checkride slot that actually runs (`types`, `lint`, `struct`,
  `dead`, `links`) in `checkride.config.json`, not just the three that were
  previously listed — the config file now matches the pipeline reality
  instead of relying on silent tool detection.

## v0.3.0 — 2026-07-10

### Added
- Run the builder on a local model (Ollama or LM Studio) with `--builder-provider ollama|lmstudio`. A local builder brings no built-in tools, so volley supplies its own workspace tool loop — read/search/list, `write_file`, `edit_file` (exact-match-or-fail), a stateless `bash`, a readability-based `fetch` with SSRF protection, and an explicit `finish` — bounded by `--builder-max-steps` (default 50) per iteration. The produced workspace goes to check + critic exactly like a Claude Code CLI build.
- Refuse a local builder by default: it runs a real host `bash` with no sandbox yet, so volley stops before any model spend unless you opt in with `--allow-unsandboxed-builder` (or `VOLLEY_ALLOW_UNSANDBOXED_BUILDER=1`), which prints a one-time warning.
- Warn at builder start when an Ollama model's context window is detectably too small (`num_ctx` below ~16k) — the most common cause of a local model silently ignoring its tools.
- Record local-builder health per iteration: a `max_steps` cutoff is surfaced as a warning rather than an error, and the run summary carries the loop's `finish_reason` and the rate of tool calls salvaged from unstructured model output.
- README `Local builder` guide and a `VOLLEY_LIVE`-gated live smoke test for the local path.

### Internal
- Enforce the spec's architecture decisions as ast-grep rules (create-engine confinement, no deep-sibling imports, no classes).
- Pin dependencies to exact versions; upgrade checkride to 0.2.1 and flesh out its config for the v3-s1 build.

## v0.2.1 — initial release

### Added
- Builder/critic loop CLI: runs a full agentic Claude Code CLI session as the builder, gates on a deterministic check pipeline (checkride auto-detected, a custom command, or none), then requires a schema-validated critic verdict before converging.
- Local critic support — point `--critic-provider` at Ollama or LM Studio to run the read-only critic on a free local model (workspace-scoped read/search/list tools, `$0` cost reporting) while the builder stays on Claude.
- Cost and iteration caps (`--max-cost-usd`, `--max-iterations`), a stable exit-code contract, and `volley resume <run-id>` to continue an interrupted run.
- Pluggable critic personas (`reviewer`, `optimizer`, `researcher`, or a custom prompt file) and a TypeScript config-file surface (`VolleyConfig`).
- `--git` flag to commit after each phase; `.volley/` run artifacts (config, summary, trajectory, per-iteration archives) for every run.
- `--json`, `--verbose`, and `--quiet` output modes for composing volley under other harnesses.

### Internal
- Built on fascicle (loop primitive, usage/cost accounting, trajectory logging) and checkride (deterministic check pipeline); both pinned to fascicle 0.8.16 / checkride 0.2.0.
- Config, CLI, and engine plumbing landed for a future local *builder* provider (`ollama`/`lmstudio`); not yet wired into execution.
- Unit and integration test suite, with opt-in live smoke tests (`VOLLEY_LIVE=1`) against the real Claude CLI and checkride.
