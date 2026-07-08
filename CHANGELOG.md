# Changelog

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
