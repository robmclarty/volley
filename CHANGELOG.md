# Changelog

## Unreleased

### Fixed
- **`--worktree` without `--git` no longer destroys a successful run's work.** With `worktree: true` and git checkpoints off (the default), a fully green run — check passed, critic approved — ended in `git branch -D` plus a forced worktree removal: the builder's uncommitted work deleted, the workspace untouched, nothing said before or after. Teardown now *salvages* that case instead — it commits the worktree's state onto the run branch (`volley/<run id>`), keeps the branch, removes only the checkout, and reports the branch as `salvaged_branch` in `.volley/summary.json` and `--json` output, so the work is recoverable with `git switch` / `git cherry-pick`. If the salvage commit itself cannot land (no git identity, a stale index lock), the checkout is left standing rather than deleted. Runs that did not converge, and `--worktree --git` runs whose work was squash-merged, still discard wholesale; the documented integrate path is unchanged.
- **A `--worktree` run's fate is now predicted before any model spend.** `--dry-run` and run start each print one line saying what a successful run will do with its effects — squash-merge onto the workspace branch (`--git`), leave them on the run branch (`--worktree` alone; a warning, since nothing is integrated), or throw them away (`--discard-worktree`) — alongside the existing critic-seat canary and `num_ctx` predictions.

### Added
- **`--discard-worktree`**: throw a `--worktree` run's effects away at teardown instead of keeping them on the run branch — "isolate the effects, I only want the verdicts". `volley matrix` forces it for every seat, so a sweep leaves neither a branch nor a squash commit per combo. Refused without `--worktree`; `--git` still wins, so `--worktree --git` integrates exactly as before.

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
