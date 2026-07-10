# Changelog

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
