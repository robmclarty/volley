# volley: upgrade ideas from Builder.io's agent-native

**Date:** 2026-10-14
**Status:** V0 was a bug and is fixed (2026-10-14, `2e826ab`, in v0.6.1). V1–V9 are ideas to pick up later;
nothing there is scheduled.
**Source:** [BuilderIO/agent-native](https://github.com/BuilderIO/agent-native) at commit
[`79aa166`](https://github.com/BuilderIO/agent-native/tree/79aa16665c2850b60e57163b123750f966b5d5cc)
(2026-10-14, MIT). Agent-native paths are relative to that tree, and every link is a permalink to it.
**Baseline:** volley v0.6.0 (`f362bbd`), on fascicle 0.12.13.
**Siblings:** the same review wrote `~/Projects/runciter/code/runciter/docs/specs/runciter-agent-native-upgrades.md`,
`~/Projects/night-shift/code/night-shift/docs/agent-native-upgrades.md` (night-shift build 2 now depends
on V2), and `~/Projects/fascicle/docs/research/fascicle-agent-native-upgrades.md` (where V4, V7, and V8's
substrate pieces belong).

## Why this exists

Agent-native is a TypeScript framework for multi-user apps where a chat agent and the UI share one action
layer. As a whole it's no use to volley, but it drives Claude Code and Codex headlessly with more care
than most harnesses do. Its Factory template also runs a builder/critic exchange over pull requests, with
rules worth stealing.

Its closest analogue to volley is the desktop app's "Multi-Frontier" mode:

- one Claude Code and one Codex propose, cross-review, and converge (at most 3 rounds);
- they wait for a human GO;
- one of them implements.

That mode has only run end to end against fake CLIs, and its live prompts never state the JSON shape its
parser requires. Read it as a design, not as working code.

## Index

| Id | Idea | Effort | Priority |
|---|---|---|---|
| V0 | Bug: `--worktree` with the Claude builder edits the workspace, not the worktree | S | fixed |
| V1 | Required/optional findings that the builder must answer; stop when nothing changed | M | high |
| V2 | Critic verdicts with checked evidence; the critic's tool calls in the archive | M | high |
| V3 | Count agent-instruction files as gate files | S | high |
| V4 | A loop breaker for local builders | S | medium |
| V5 | Plan limits between iterations; a login check in `--dry-run` | S | medium |
| V6 | Atomic `.volley/` writes | S | medium |
| V7 | Name the real error from `.cause` chains | S | medium |
| V8 | Isolation flags for unattended Claude sessions | S | low |
| V9 | Consequence classes for findings | M | later |

---

## V0. Bug: `--worktree` with the Claude builder edits the workspace, not the worktree

Found while comparing volley with agent-native; nothing in agent-native caused it.

**What happens.**

- `create_volley_engine` sets `claude_cli.default_cwd: options.workspace` (`src/engine.ts:155-157`), and
  `src/orchestrator.ts:145-149` calls it with `workspace: config.workspace`.
- The `claude_cli` arm of `builder_generate_options` (`src/builder.ts:111-119`) passes only
  `allowed_tools` and the permission mode, and fascicle's `claude_cli` has no per-call cwd. It always
  spawns in `default_cwd` (fascicle `src/engine/providers/claude_cli/adapter.ts:784`).
- Everything else uses `build_root(config.workspace, config.worktree)`, which is the worktree under
  `--worktree`:
  - the check (`src/phases.ts:77`);
  - change detection (`src/phases.ts:129`);
  - git checkpoints (`src/phases.ts:136`, `:217`);
  - a local critic's tools (`src/critic/run.ts:87`).

So with `--worktree` and the default Claude builder:

- the builder edits your checkout;
- the check runs against the untouched worktree;
- the critic is told nothing changed;
- if the run still succeeds, its branch carries none of the edits, which stay uncommitted in the
  workspace.

`volley matrix` forces `--worktree --discard-worktree`, so a sweep with a Claude builder would edit your
checkout on every combo and discard nothing.

**Why tests miss it.** `test/integration/worktree.test.ts` drives `mock_engine` with
`builder_provider: 'ollama'`, which never reaches `create_volley_engine`.

**Who's affected.**

- Not runciter: its planned `volley` kind runs without `--worktree`, per its R5.
- Not night-shift: it uses local builders.
- Affected: standalone runs and sweeps with a Claude builder.

**Fix.** In `src/orchestrator.ts`, pass `workspace: build_root(config.workspace, config.worktree)` to
`create_volley_engine`. `.volley/` state is unaffected, because `default_cwd` only sets the Claude session's
working directory. A per-call cwd in fascicle (fascicle doc AN10) would make this class of bug harder to
write.

**Fixed 2026-10-14 in `2e826ab` (v0.6.1).**

- `src/orchestrator.ts` now creates the engine with `build_root(config.workspace, config.worktree)`.
- The doc comments in `src/engine.ts` say what that directory is.
- `test/integration/claude_cli_worktree.test.ts` drives the real engine against a fake `claude`
  (`VOLLEY_CLAUDE_BIN`) that writes a marker into its cwd. The test asserts that the marker never reaches
  the workspace and is on the salvaged `volley/<run_id>` branch.
  - Before the fix, it failed: the run reported `success` while the marker sat in the workspace.
  - After the fix, it passes, and so does `pnpm check`.

## V1. Required/optional findings that the builder must answer; stop when nothing changed

**Problem.**

- The verdict schema is `{ verdict, feedback, unmet_criteria }` (`src/critic/run.ts:25-44`).
- The builder gets the feedback as prose and either acts on it or doesn't.
- When builder and critic disagree, volley loops to `--max-iterations` (default 10).
- Every iteration re-runs the check and the critic, even when the builder changed nothing.

**In agent-native.** Factory's pull-request "babysitter" makes the builder answer each open finding
explicitly
([templates/factory/server/triage/pr-babysit.ts L118–128](https://github.com/BuilderIO/agent-native/blob/79aa16665c2850b60e57163b123750f966b5d5cc/templates/factory/server/triage/pr-babysit.ts#L118-L128)):

```text
look at the latest PR feedback and fix anything you agree with. Be skeptical.

Reply in each **open inline thread** with exactly one of:
- `Required — fixed: …`
- `Required — not fixing: …`
- `Optional — skipping: …`
```

- A "Required — not fixing" marks the PR `stuck` and hands it to a human.
- The scheduler refuses to ping again when the head commit is unchanged and there is no new work.
- The next step (`ping`, `defer`, `already_asked`, `clean`, or `stuck`) is computed in code with a
  `because`, not left to the model.

**Proposal.**

1. **Findings.** The verdict gains `findings: [{ id, severity: 'required' | 'optional', text }]`.
   `unmet_criteria` stays for compatibility.
2. **Dispositions.** The builder prompt lists the open findings and asks for a closing `DISPOSITIONS`
   block, one line per finding id: `fixed`, `not fixing: <reason>`, or, for optional findings only,
   `skipping`. Parsing is lenient, and a missing block means no dispositions.
3. **Declining.** A `not fixing` on a required finding ends the run with a new status, `declined` (exit 9),
   carrying the builder's reason. It doesn't loop: a builder and critic that disagree on substance need a
   human, not eight more iterations.
4. **Unchanged trees.** Before the check, compare the build root's tree with the previous iteration's: a
   `git write-tree` over a temporary index, or the checkpoint sha under `--git`.
   - When nothing changed, skip the check and the critic, carry the previous verdict forward, and record
     the iteration as `no_change`.
   - Two unchanged iterations in a row end the run as exit 2 with reason `no_progress`.

**Done when.**

- Unit tests cover disposition parsing.
- A mock critic returning a required finding, plus a mock builder answering `not fixing: …`, ends
  `declined` after one iteration.
- A builder that edits nothing makes iteration 2 skip the critic call, and ends `no_progress` at
  iteration 3.

## V2. Critic verdicts with checked evidence; the critic's tool calls in the archive

**Problem.**

- Night-shift's build 2 ran a critic bake-off (its D39 and `docs/first-run.md:458`):
  - no local critic caught the false claim planted in the `volley/d5cff246` draft;
  - `qwen3:8b` approved drafts after zero tool calls.
- Today an approval from a critic that read nothing looks exactly like one from a critic that read
  everything.
- The iteration archive records the builder's `tool_calls` but not the critic's (`src/summary.ts:105-108`).

**In agent-native.** Brain's knowledge writer rejects evidence that isn't a verbatim substring of its
source
([templates/brain/.agents/skills/brain/SKILL.md L24–31](https://github.com/BuilderIO/agent-native/blob/79aa16665c2850b60e57163b123750f966b5d5cc/templates/brain/.agents/skills/brain/SKILL.md#L24-L31)):
"`validateEvidence` … throws if `evidence[].quote` is not found verbatim in the referenced capture's
content. … do not paraphrase."

**Proposal.**

1. **Evidence field.** The verdict gains `evidence: [{ path, quote }]`. The schema describes the quote as
   exact text copied from a file the critic read, and asks for at least one quote with an approval.
2. **Checking quotes.** The harness checks each quote is a substring of the file at `path` inside the build
   root:
   - line endings are normalized;
   - paths that escape the build root are refused;
   - at most 20 quotes of 500 characters each are checked.
3. **Unverified approvals.** An approval with no verified quote is recorded as `critic_unverified: true`
   in the iteration archive and the run summary, beside `critic_degraded`. With
   `--require-critic-evidence`, it becomes `changes_requested`, with feedback asking for quotes from the
   files read.
4. **Archive.** The archive's `critic` block gains `tool_calls`, next to the builder's. It is null when the
   provider doesn't report tool calls. Night-shift's build 2 step 17 reads this field.

This doesn't make a critic smarter. It turns "didn't read" from a silent approval into a visible state, and
it gives night-shift's 30-night measurement a cheap signal.

**Done when.**

- Unit tests cover quote verification: exact, whitespace-normalized, missing file, and an escaping path.
- A mock critic approving with a fabricated quote yields `critic_unverified`.
- The same run with `--require-critic-evidence` yields `changes_requested`.

## V3. Count agent-instruction files as gate files

**Problem.**

- `DEFAULT_GATE_PATTERNS` (`src/changes.ts:36-51`) covers tests, fixtures, check config, `package.json`,
  and workflows.
- It doesn't cover the files that instruct the agents: `CLAUDE.md`, `AGENTS.md`, `.claude/**`, skills,
  `.mcp.json`.
- A Claude critic reads its working tree's `CLAUDE.md` like any Claude Code session, and volley loads
  project and local settings (`src/engine.ts:157`). A builder that edits those files is editing the next
  builder's and the critic's instructions, and today that doesn't count as a gate edit.

**In agent-native.** Factory's never-automate list explicitly includes the gate's own inputs: `AGENTS.md`,
`CLAUDE.md`, `*/SKILL.md`, its policy files, `.claude/settings.json`, and `scripts/guard-*`
([pr-policy.ts L425](https://github.com/BuilderIO/agent-native/blob/79aa16665c2850b60e57163b123750f966b5d5cc/templates/factory/server/triage/pr-policy.ts#L425)).
It normalizes camelCase and strips `.spec`/`.test`, so tests of sensitive files count too. Its review skill
adds that changes to review policy or agent-safety instructions need an independent reviewer.

**Proposal.** Add the following to `DEFAULT_GATE_PATTERNS`:

- `**/CLAUDE.md`
- `**/AGENTS.md`
- `.claude/**`
- `**/SKILL.md`
- `.mcp.json`
- the `--critic` prompt file, when it lives inside the build root

**Done when.** A builder that edits `CLAUDE.md` shows in `comparison.gate_edits`, and
`--fail-on-gate-edit` exits 8.

## V4. A loop breaker for local builders

**Problem.** A small local model often repeats one tool call. Volley lets it burn steps up to
`--builder-max-steps` (default 50), then records a `max_steps` warning and hands partial work on with no
summary (`src/builder.ts:179-190`).

**In agent-native.**

- **Triggers:** 8 identical calls (same name and arguments) in one turn, or 3 identical errors
  ([production-agent.ts L4480–4482](https://github.com/BuilderIO/agent-native/blob/79aa16665c2850b60e57163b123750f966b5d5cc/packages/core/src/agent/production-agent.ts#L4480-L4482)).
- **What it does instead of a hard stop:** the loop injects a closing instruction, then calls the model
  once more with no tools
  ([L8822](https://github.com/BuilderIO/agent-native/blob/79aa16665c2850b60e57163b123750f966b5d5cc/packages/core/src/agent/production-agent.ts#L8822)):

```text
This turn stopped to prevent a repeating tool loop: <reason>
Write one concise closing message saying what you completed and what remains. Use the tool results above
as evidence. Do not call tools or repeat checks.
```

**Proposal.**

- The breaker belongs in fascicle's tool loop (`src/engine/tool_loop.ts`; fascicle doc AN4).
- Volley turns it on for local builders and records `loop_broken`, with the repeated call, in the
  iteration archive.
- The closing message reaches the critic as the builder's summary.

## V5. Plan limits between iterations; a login check in `--dry-run`

**Problem.**

- A Claude session that hits the plan limit fails mid-flight and maps to exit 3 (`rate_limit_error`,
  `src/exit_codes.ts:45`).
- fascicle already records `cli_rate_limit_event` in the trajectory, with status, type, `resets_at`, and
  overage fields (fascicle `src/engine/providers/claude_cli/stream_parse.ts:428-446`). Nothing reads it.
- `--dry-run` checks checkride, the worktree, endpoints, and the critic seat (`src/preflight.ts:169-301`),
  but not which Claude login a run will bill.

**In agent-native.**

- Their drivers refuse to start unless `claude auth status --json` reports `authMethod: "claude.ai"` and
  `apiProvider: "firstParty"`
  ([claude-code-participant.ts L161–195](https://github.com/BuilderIO/agent-native/blob/79aa16665c2850b60e57163b123750f966b5d5cc/packages/core/src/cli/claude-code-participant.ts#L161-L195)).
  On this machine, Claude Code 2.1.283 returns those fields.
- They found no way to read live Claude plan usage from `--print` sessions
  ([MULTI_FRONTIER_PROOF.md L309–324](https://github.com/BuilderIO/agent-native/blob/79aa16665c2850b60e57163b123750f966b5d5cc/packages/desktop-app/MULTI_FRONTIER_PROOF.md#L309-L324)),
  so the rate-limit event is the only live signal.
- For Codex, `codex app-server` answers `account/rateLimits/read` with `usedPercent` and `resetsAt` per
  window
  ([codex-subscription.ts L629–747](https://github.com/BuilderIO/agent-native/blob/79aa16665c2850b60e57163b123750f966b5d5cc/packages/desktop-app/src/main/codex-subscription.ts#L629-L747);
  experimental).

**Proposal.**

1. **Stop before the limit.** After each phase, read the newest `cli_rate_limit_event`. If it reports
   anything other than plain allowed use, or overage, stop before the next session with a new status,
   `rate_limited` (exit 10). Report `resets_at`, so `volley resume` after the reset picks up where the run
   stopped. If fascicle surfaces this on `GenerateResult` (fascicle doc AN9), read it there instead of
   parsing the trajectory.
2. **Login check.** When a role uses `claude_cli`, `--dry-run` runs `claude auth status --json`:
   - under `VOLLEY_AUTH_MODE` `auto` or `oauth`, it warns unless the login is `claude.ai` / `firstParty`;
   - under `api_key`, it warns when the key is missing.

## V6. Atomic `.volley/` writes

**Problem.**

- `write_json` (`src/iteration.ts:31-33`), the run summary writer (`src/summary.ts:208-213`), and
  `persist_verdict_files` all use plain `writeFileSync`.
- A crash or SIGKILL mid-write leaves a torn `summary.json` or iteration file, and `volley resume` reads
  those back.

**In agent-native.** `atomic-json-file.ts`
([L53–84](https://github.com/BuilderIO/agent-native/blob/79aa16665c2850b60e57163b123750f966b5d5cc/packages/core/src/cli/atomic-json-file.ts#L53-L84))
writes a temp file in the same directory, opened `wx`, then renames it over the target. It also has an
`O_EXCL` lock that holds pid and token and reclaims a dead pid's lock after 30 s. An 8-process test drives
it.

**Proposal.**

- One `write_file_atomic(path, text)` helper, using a same-directory temp file, `wx`, and `renameSync`,
  for every `.volley/` write.
- No lock is needed while one process owns a run.

**Done when.** A rename that throws leaves the previous file byte-for-byte intact and no temp file behind.

## V7. Name the real error from `.cause` chains

**Problem.** The README documents opaque deaths like `stream interrupted: fetch failed`. The real cause
(`ECONNRESET`, an undici timeout code) usually sits one or two links down the error's `.cause` chain.

**In agent-native.**

- `describeErrorWithCauses` walks `.cause` up to four links and includes each `code`
  ([agent/engine/error-detail.ts L16–40](https://github.com/BuilderIO/agent-native/blob/79aa16665c2850b60e57163b123750f966b5d5cc/packages/core/src/agent/engine/error-detail.ts#L16-L40)).
- The same file explains why
  ([L289–294](https://github.com/BuilderIO/agent-native/blob/79aa16665c2850b60e57163b123750f966b5d5cc/packages/core/src/agent/engine/error-detail.ts#L289-L294)):
  transient failures stored as `unknown` weren't auto-recovered, and "over four days that gap was 28% of
  ALL production chat turns."

**Proposal.**

- Describe errors with their cause chain wherever volley writes a summary or exit detail.
- Record the innermost `code` as `error_code` in the iteration archive, so the matrix's `why` column can
  name it.
- The helper belongs in fascicle (fascicle doc AN8); volley adopts it.

## V8. Isolation flags for unattended Claude sessions

**Problem.**

- `setting_sources: ['project', 'local']` (`src/engine.ts:157`) loads the workspace's checked-in
  `.claude/settings.json`, whose hooks run shell commands.
- No `--strict-mcp-config` is passed, so every Claude session also sees every MCP server in your user
  config.
- Both make runs depend on whose machine and which repo they run in. That hurts `volley matrix` most, since
  reproducibility is its whole point.

**In agent-native.** The Claude argv always carries `--setting-sources ""`, `--strict-mcp-config`, and
`--disable-slash-commands`
([claude-code-participant.ts L228–243](https://github.com/BuilderIO/agent-native/blob/79aa16665c2850b60e57163b123750f966b5d5cc/packages/core/src/cli/claude-code-participant.ts#L228-L243)).

**Proposal.**

- A config key, `claude_isolation: true`, sends `setting_sources: []` and `--strict-mcp-config`.
- It is on by default for `volley matrix` and opt-in elsewhere.
- fascicle already renders `setting_sources: []` as `--setting-sources ""`, because its argv builder
  joins the list (`src/engine/providers/claude_cli/argv.ts:37-39`). That is the same argv agent-native
  uses.
- `--strict-mcp-config` can ride in `extra_args` until fascicle has an option for it (fascicle doc AN7).

## V9. Consequence classes for findings (later)

Multi-Frontier's cross-review makes each finding name its consequence.

- **How it works:** anything not `reversible_technical` pauses for a human instead of looping
  ([multi-frontier-orchestrator.ts L516–622](https://github.com/BuilderIO/agent-native/blob/79aa16665c2850b60e57163b123750f966b5d5cc/packages/desktop-app/src/main/multi-frontier-orchestrator.ts#L516-L622)).
- **For volley:** a third severity on V1's findings, `consequential`, ends the run for a human the way
  `declined` does.
- **When:** wait until V1 has run for a while.

---

## Not adopting

- **Multi-Frontier's code.** It is proven only against fake CLIs. Its Claude driver has no Bash, so a
  Claude-driven run can't produce the test evidence its own completion rule requires.
- **The "provider-observed test" rule.** Multi-Frontier only counts a test run it saw the agent execute.
  Volley already runs the check itself, which is stronger.
