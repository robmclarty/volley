# volley — Dependency follow-ups spec (after the 2026-09-24 bump)

A plan-ready specification for the six items the 2026-09-24 dependency bump
surfaced but deliberately left open. The bump itself shipped as `762c909`,
`e150f9e`, `0c70939`, `1c391aa`, and `6943bf6`, which took volley to fascicle
0.12.8, checkride 0.13.0, vitest 5, TypeScript 6, and undici 8.11 and left
`pnpm check` green. Nothing here is broken today in the sense of a red gate; each
item is either a behavior change the gate cannot see, a version held back on
purpose, or enforcement that was switched off to keep the bump scoped.

Everything true in [`volley-spec-v2.md`](./volley-spec-v2.md) and
[`volley-spec-v3-reconciled.md`](./volley-spec-v3-reconciled.md) carries forward.

---

## Baseline — where the bump left things

| Area | State after the bump | Held back because |
|---|---|---|
| TypeScript | `6.0.3` | TS 7 typechecks volley cleanly, but its npm package exports no JS compiler API; tsup's dts build (`rollup-plugin-dts`) crashes on it (`useCaseSensitiveFileNames` of undefined). |
| Build | tsup `8.5.1` with `dts.compilerOptions.ignoreDeprecations: '6.0'` ([`tsup.config.ts`](../../tsup.config.ts)) | tsup injects `baseUrl`, which TS 6 deprecates (TS5101). tsup is in maintenance mode. |
| `pnpm audit` | 1 low: esbuild GHSA-g7r4-m6w7-qqqr (dev-server file read, Windows only) | Pinned by tsup's `esbuild@^0.27`; fixed in `>=0.28.1`. Not reachable in volley, which never runs esbuild's dev server. |
| zod | `4.4.3` | fascicle ≥0.10.3 peers `zod: "4.4.3"` **exactly**. Latest is 4.6.5. |
| Local critic | Throws on a step-cap / tool-call finish | fascicle 0.10.1 made schema calls throw `incomplete_generation_error` on any non-`stop` finish; volley's degradation ladder only knows `provider_error`. |
| checkride summary | `checks_run` ignored; schema-version warning dropped | Gaps from before the bump that the review turned up. |
| fallow | `dead` + `dupes` slots gate; `health` off | 14 functions over `fallow.toml`'s thresholds. |

---

## F1 — Local critic: route step exhaustion to the tool-less rung

**Priority: highest.** A real run can hit this today, and it turns what used to
be a degraded-but-completed run into a hard exit 6.

### Problem

fascicle 0.10.1 changed `generate` so a call **with a schema** that finishes on
anything but `stop` throws `incomplete_generation_error` (fields: `finish_reason`,
`raw_text`, `provider_reported`) instead of returning raw text cast to the schema
type. See fascicle's `CHANGELOG.md`, the v0.10.1 entry beginning "A schema call that
finished without finishing". The critic always passes `schema: verdict_schema`,
so for a **local** critic the finishes `max_steps`, `tool_calls`, `length`, and
`content_filter` now throw.

The critic passes no `max_steps`, so it inherits the engine default of **10**
(fascicle `src/engine/create_engine.ts:107`). A local critic that spends ten
steps reading files without producing a verdict is the realistic trigger.

volley's ladder handles only `provider_error`:

- `is_retryable_critic_error` ([`src/critic/run.ts:92`](../../src/critic/run.ts))
  returns true only for `error_kind(err) === 'provider_error'`.
- `run_critic` rung 1 (`src/critic/run.ts:300-313`) rethrows anything else
  straight to `phase_error`, so rung 2 (the tool-less fallback, `:317-331`) is
  never reached, and the run exits **6**.
- `critic_canary` (`src/critic/run.ts:241`) classifies any non-`provider_error` as
  `failed`, so `--dry-run` exits **5** for a combo that a tool-less fallback would
  have saved.

Before 0.10.1 this same case "succeeded" with `verdict: undefined`, so it was
already wrong. It was just wrong silently.

The builder is **not** affected: it calls `generate` without a schema, and
`max_steps` there is an expected, warned outcome (`src/builder.ts:170-236`).
`claude_cli` critics are not affected either: that adapter reports every
completion as `stop`.

### Approach

1. **Classify.** Add a predicate next to `is_retryable_critic_error`, for example
   `is_tool_phase_exhaustion(config, ctx, err)`. It is true when the critic is
   local, the run is not aborted, `error_kind(err) === 'incomplete_generation_error'`,
   and `finish_reason` is `max_steps` or `tool_calls`. Match on `kind` and
   `finish_reason` only, never the message, per house style.
2. **Route to rung 2 without retrying.** Step exhaustion is not the stochastic
   stream death rung 1 exists for, so a same-call retry wastes a full tool loop.
   On exhaustion, skip straight to the tool-less pass. It is already
   schema-constrained and grounded by the workspace inventory.
3. **Leave `length` and `content_filter` fatal.** A truncated or blocked
   response is not fixed by removing tools, and fascicle deliberately does not
   repair them. They stay `phase_error` / exit 6. The error message should name
   the `finish_reason`, so the operator sees *why* rather than a bare
   incomplete-generation message.
4. **Record the cause.** The degraded record currently carries `retries` and
   `retry_cause_kind` (`provider_5xx | network | unknown`). Add a field saying
   *why* the ladder degraded (e.g. `degrade_cause: 'stream_error' | 'step_exhaustion'`),
   carried into the iteration summary, the run `comparison` block, and the
   `volley matrix` row's `why`. A `deg` flag with no cause makes the matrix table
   misleading.
5. **Canary parity.** `critic_canary` must predict the ladder, so a tool-bearing
   `max_steps` / `tool_calls` death probes tool-less and returns `degraded`,
   exactly as a `provider_error` does today.
6. **Make the step budget explicit.** Pass `max_steps` on the critic's
   tool-bearing call instead of inheriting fascicle's engine default, so a future
   fascicle default change cannot move it silently. Keep it at 10 unless live runs
   say otherwise.

### Acceptance

- Unit tests (`test/unit/critic_retry.test.ts` pattern, mock engine throwing
  `new incomplete_generation_error('max_steps', '…')`):
  - `max_steps` and `tool_calls` → exactly one tool-less call, record
    `critic_degraded: true`, the cause recorded, 0 retries;
  - `length` and `content_filter` → `phase_error` with `phase: 'critic'`, no
    fallback call;
  - a `claude_cli` critic never enters the new branch.
- Preflight tests (`test/unit/preflight.test.ts`, `canary_engine`): a
  `max_steps` tool-phase death with a surviving tool-less probe → `degraded`
  (warn, exit 0); a surviving-nothing case still → `failed` (exit 5).
- The new record field appears in `.volley/summary.json` `comparison` and in the
  `volley matrix --json` attempt detail, and the table's `why` names it.
- README's local-critic resilience section states which finishes degrade and
  which are fatal.

### Open question

- Should the critic step cap be user-configurable (`--critic-max-steps`,
  mirroring `--builder-max-steps`)? Recommendation: not until a live run shows 10
  is wrong. Making it explicit (step 6) is enough for now.

---

## F2 — checkride summary: honor `checks_run`, surface the schema warning

### Problem

1. **Vacuous green passes the gate.** Since checkride 0.3.0, `summary.json`
   carries a top-level `checks_run`: `ok: true` with `checks_run: 0` means
   *nothing was verified* (checkride `CHANGELOG.md`, 0.3.0, "Vacuous-green
   signal"). volley's `CheckrideSummary` type
   ([`src/check/checkride.ts:28`](../../src/check/checkride.ts)) has no
   `checks_run`, and `run_checkride` copies `ok: summary.ok` straight through
   (`:164`). A workspace where every slot sat out therefore counts as a passing
   check, and the loop can converge on an unverified tree once the critic
   approves.
2. **The schema-version warning is computed and then dropped.**
   `parse_checkride_summary` (`:83`) returns a `warning` when `schema_version`
   ≠ 1, but `run_checkride` destructures only `{ summary }` (`:159`). The
   "parsing best-effort" notice never reaches the operator.
3. **Test doubles drifted from the contract.** The fake checkride binary in
   [`test/integration/checkride_gate.test.ts:25`](../../test/integration/checkride_gate.test.ts)
   and the `summary_fixture` in `test/unit/checkride_summary.test.ts` omit
   `checks_run`, which the real contract has required since 0.3.0 (checkride
   publishes it as `schema/checkride.summary.schema.json`).

### Approach

- Add `checks_run: number` to `CheckrideSummary`. When it is **missing** (a
  pre-0.3.0 checkride), treat it as unknown and keep today's behavior, but warn.
- **Decision: a vacuous green is a failed check, not a harness error.** When
  `ok === true && checks_run === 0`, `run_checkride` returns `ok: false` with a
  synthetic failing entry such as `failing_slots: ['(no checks ran)']`. Its
  detail should tell the builder and critic that nothing was verified and why.
  Take the per-slot `reason`s from the summary's skipped rows.
  - The rejected alternative is passing checkride's `--strict`, which turns this
    case into exit 2. volley maps exit 2 to `check_error` (exit 4), which kills
    the run. That is wrong when the zero-check state is builder-fixable, for
    example a greenfield workspace where the test slot has nothing to run yet.
- Carry parse warnings out of `run_checkride`, e.g. `warnings: string[]` on
  `CheckResult`, and have the orchestrator's `check` step pass them to
  `renderer.warn`.
- `--dry-run`: if `checkride doctor` predicts zero runnable slots, say so in the
  preflight output. Warn only; this is not an exit-5 condition.
- Bring both test doubles up to the real contract. Consider validating the fake
  summary against checkride's published summary schema, so the shims cannot drift
  again.

### Acceptance

- Unit tests: `ok: true, checks_run: 0` → `CheckResult.ok === false` with the
  synthetic slot. `ok: true, checks_run: 3` → unchanged. `checks_run` absent →
  unchanged plus a warning.
- A `schema_version: 2` summary produces a visible `warn` line in a run (an
  integration test through the fake binary).
- Both fakes emit `checks_run`, and the fake-binary summary validates against
  `node_modules/checkride/schema/checkride.summary.schema.json`.

---

## F3 — Replace tsup with tsdown; move to TypeScript 7

### Problem

TypeScript 7 (the native compiler) typechecks volley cleanly and is much faster.
But its npm package's `.` export is only `lib/version.cjs` plus `./unstable/*`
entry points. The classic `require('typescript')` compiler API is gone, and tsup's
bundled `rollup-plugin-dts` needs it. tsup is in maintenance mode and its
successor is **tsdown**. Moving off tsup also drops the last `pnpm audit` finding:
tsup's `esbuild@^0.27` pin.

State on 2026-09-24 (from the registry, **not yet spiked**): `tsdown@0.23.0`
peers `typescript: ^5 || ^6 || ^7`, and `rolldown-plugin-dts@0.28.6` peers
`typescript: ^5 || ^6 || ~7.0.0`. Both require Node `^24.11.0` on the 24 line;
the Dockerfile's `node:24-bookworm-slim` and CI's `node-version: 24` resolve past
that.

### The published-artifact contract to preserve

The migration is only correct if the tarball is byte-for-byte equivalent in
shape. Pin these down before switching:

- `bin.volley` → `dist/cli.js`: ESM with its `#!/usr/bin/env node` shebang,
  executable.
- `main` → `dist/index.js`; `types` → `dist/index.d.ts`, a **single bundled**
  declaration file (tsup emits one ~16 KB `index.d.ts` today; it must not become
  a tree of per-module `.d.ts` files).
- **`.js` / `.d.ts` extensions, not `.mjs` / `.d.mts`.** Check tsdown's
  `fixedExtension` default for `platform: 'node'` and set it explicitly.
- Sourcemaps, `target: node24`, no code splitting, `clean`.
- `dist/` sits directly under the package root. `package_version()` in
  [`src/cli.ts`](../../src/cli.ts) and `presets_dir()` both walk up from the
  built module to find `package.json` and the preset files, so a nested output
  directory would break `--version` and critic presets in the published package.
- `files` in `package.json` is unchanged.

### Approach

1. **Spike on TS 6 first.** Swap tsup for tsdown while keeping TS 6.0.3. Diff
   `pnpm pack --dry-run` file lists and `dist/index.d.ts` against the tsup
   output. Only when the artifact matches, bump `typescript` to 7.x, then drop
   `ignoreDeprecations` and delete `tsup.config.ts`.
2. Confirm TS 7 still satisfies checkride's `types` slot (`tsc --build`) and
   `pnpm typecheck` (`tsc --noEmit`). Both passed in a trial on 2026-09-24.
   `oxlint-tsgolint` embeds its own compiler and is unaffected.
3. Rebuild the sandbox image (`Dockerfile:50` runs `pnpm build`) and run the
   all-local in-container `--dry-run` from
   [`examples/all-local/README.md`](../../examples/all-local/README.md), since
   the image *is* the published build.
4. If tsdown's TS 7 dts path turns out not to work, the fallback is
   `tsc --emitDeclarationOnly` into a temp dir, bundled with a standalone dts
   bundler. Only take it if the spike fails.

### Acceptance

- `pnpm build` and `pnpm check` are green on TypeScript 7.
- `pnpm pack --dry-run` lists the same files as before, and the diff of
  `dist/index.d.ts` shows only formatting-level changes.
- `node dist/cli.js --version` prints the manifest version. A packed-and-installed
  tarball runs `volley --help` and resolves a critic preset.
- `pnpm audit` reports **0** vulnerabilities.
- `docker build` succeeds, and the all-local in-container dry-run exits 0.
- Optional one-off check: `pnpm exec checkride --include publint,attw` (checkride's
  opt-in library-publishing slots) passes.

---

## F4 — Turn on the fallow `health` slot

### Problem

`fallow.toml` configures `[health]` (`maxCyclomatic = 15`, `maxCognitive = 15`;
`maxCrap` defaults to 30), but no slot runs it. checkride ≥0.4.2 split fallow
into per-analysis slots, and only `dead` and `dupes` are enabled. Running
`fallow health` on 2026-09-24 reports **14** findings:

**Over the complexity thresholds (refactor targets):**

| Function | Location | Cyclomatic / Cognitive |
|---|---|---|
| `resolve_config` | `src/config.ts:214` | 54 / 54 |
| `merge_flags` | `src/cli.ts:152` | 26 / 25 |
| `preflight` | `src/preflight.ts:205` | 20 / 29 |
| `load_resume_state` | `src/iteration.ts:175` | 24 / 20 |
| chunk-handler arrow | `src/render/renderer.ts:64` | 18 / 23 |
| `archive_iteration` | `src/iteration.ts:77` | 12 / 20 |
| `walk` | `src/workspace_tools.ts:50` | 9 / 19 |
| `execute` (read tool) | `src/workspace_tools.ts:142` | 11 / 17 |
| `glob_to_regexp` | `src/changes.ts:155` | 9 / 16 |

**Over the CRAP threshold only** (CRAP = complexity × estimated coverage):
`run_fetch` (`src/builder/tools.ts:386`), `extract_markdown`
(`src/builder/tools.ts:316`), and `format_check_section`
(`src/critic/prompt.ts:127`), plus two test helpers: `stub_summary`
(`test/unit/matrix.test.ts:22`) and the mock engine's `generate`
(`test/helpers/mock_engine.ts:53`).

### Approach

1. **Scope test code out of health:** `[health] ignore = ["test/**"]`. Test
   helpers are not the maintainability target, and they account for two of the 14.
2. **Refactor the nine complexity offenders, behavior-preserving.** Keep
   extractions *within* each module: no new cross-module imports, and respect
   `no-deep-sibling-import`.
   - `resolve_config` is the big one. Split it by concern: provider/model
     resolution, containment policy (the claude_cli-is-host-only rule from
     `VOLLEY_CONTAINED`), worktree and gate settings, caps. Each step returns a
     partial.
   - `merge_flags` is a long run of conditional spreads, and a table from CLI flag
     to config key collapses it.
   - `preflight` splits by check (toolchain, worktree, endpoint, canary, gate
     posture).
   - `load_resume_state` and `archive_iteration` split into validate / read /
     assemble steps.
   - For the renderer arrow, give each `StreamChunk` kind its own handler.
3. **The CRAP-only three need tests, not refactors.** They carry the most
   network and markdown edge cases (`run_fetch` covers SSRF deny, pagination, and
   non-HTML bodies), and the score reflects missing coverage. Alternatively, use a
   `thresholdOverrides` entry with a stated reason. Do **not** raise `maxCrap`
   globally.
4. **Enable the slot:** `"health": "fallow"` in `checkride.config.json`, and add
   `health` to the slot list in the `/version` skill's verify note
   (`.claude/skills/version/SKILL.md`).

### Constraint worth knowing

fallow can score CRAP from real Istanbul coverage (`[health] coverage = …`), but
checkride runs `test` and `health` **concurrently** in the same wave. A health
slot cannot depend on coverage that the same `pnpm check` run is still writing.
Stay on estimated coverage unless checkride grows slot ordering for this.

### Acceptance

- `fallow health --format json` reports 0 findings under the committed
  `fallow.toml`.
- `pnpm check` is green with `health` enabled.
- Existing tests pass unchanged; test files are *not* edited to accommodate the
  refactors, which is the behavior-preservation check. New tests are added only
  for the CRAP-only functions.

### Sequencing note

Land F1 and F2 first. Both touch `src/critic/run.ts` and `src/check/`, and
refactoring `preflight` before F1 changes the canary would mean doing it twice.

---

## F5 — Unblock zod (cross-repo, starts in fascicle)

### Problem

volley can't take zod past 4.4.3 because fascicle ≥0.10.3 peers
`"zod": "4.4.3"` exactly (fascicle `package.json`; the rationale is in fascicle's
`CHANGELOG.md` under "The `zod` peer dependency is pinned to exactly `4.4.3`").
The pin is deliberate. fascicle emits provider JSON Schema via Standard JSON
Schema (`~standard.jsonSchema`), which only exists from zod 4.2.0, and the exact
pin makes "the version we test" equal "the version we promise". The cost is that
every consumer is frozen, and any other package that peers a different zod range
cannot co-install.

### Approach

This is a **fascicle** change first; volley only follows.

1. In fascicle: widen the peer to a range whose floor is proven, e.g.
   `>=4.2.0 <5` or `^4.4.3`. Keep the tested-equals-promised guarantee by running
   fascicle's suite against both the floor and the latest 4.x in CI. The changelog
   already records that 4.2.0 and 4.4.3 emit byte-identical draft-2020-12
   schemas, which supports a range floor.
2. Release fascicle, then in volley bump fascicle and move `zod` to the latest
   mature 4.x.
3. Verify volley's two schema paths still emit what their consumers accept:
   - the `claude_cli` `--json-schema` path. fascicle strips `$schema` / `$id`;
     confirm that still holds on the new zod.
   - the `ai_sdk` local path, covering both the verdict schema and the builder and
     critic tool `input_schema`s.

### Acceptance

- `pnpm install` reports no peer conflicts, and `pnpm why zod` shows one version.
- `pnpm check` is green.
- `VOLLEY_LIVE=1` smoke passes for a `claude_cli` critic verdict and a local critic
  verdict.
- The critic canary passes for a local critic.

### If fascicle keeps the exact pin

That is a legitimate choice. Then this item becomes "bump zod in lockstep
whenever fascicle bumps its pin", and the spec for it is one line in the release
checklist.

---

## F6 — Housekeeping (machine-local, not repo changes)

- The 2026-09-24 rebuild of `volley-sandbox:latest` left the previous image
  (`c9cb7c211395`) untagged. Remove it with `docker image prune` or
  `docker image rm c9cb7c211395`.
- `examples/all-local/.pnpm-store/` is pnpm's relocated store from in-container
  installs. It is gitignored and harmless, and can be deleted to reclaim space.
  The next in-container install recreates it.

---

## Suggested order

| Order | Item | Why here | Size |
|---|---|---|---|
| 1 | **F1** critic step exhaustion | Live behavior change; a real local run can hit it | S–M |
| 2 | **F2** `checks_run` + warning | Gate correctness; small and self-contained | S |
| 3 | **F3** tsdown + TS 7 | Clears the last audit finding; independent of F1/F2 | M (spike-gated) |
| 4 | **F4** health slot | Largest and pure refactor; do it after the code F1/F2 touch settles | L |
| 5 | **F5** zod | Blocked on a fascicle release | S in volley |
| — | **F6** | Any time | trivial |

F1, F2, and F3 can go to separate sessions in parallel. F4 should follow F1 and
F2.

## Whole-spec verification

Once every item is done:

- `pnpm check` is green with `types lint struct dead dupes health test links`.
- `pnpm build` passes, and `pnpm audit` reports 0.
- `docker build` passes.
- Every `examples/**/volley.config.ts` passes `--dry-run`. Pulled models are
  required for the local ones; `local-critic` and `all-local` name `qwen3:32b` as
  a placeholder, so swap it at the CLI.
- The ladder gates still start red on their seeds.

## Noticed, deliberately out of scope

- The ladder already uses the v3 finding's models (`qwen3.6` builder,
  `glm-4.7-flash` critic), but `local-critic` and `all-local` still say `qwen3:32b`.
  Their READMEs document it as swap-your-own, so this is a doc choice, not a bug.
- Target repos set up with checkride ≥0.10.2 get `permissions.deny` rules for
  `.check/**` and a Stop-hook gate that re-runs checks. A `claude_cli` builder
  loads project settings (`src/engine.ts`), so it inherits both. That is fine
  today, but it is worth knowing if a builder session ever loops on the hook.
- Trajectory files grew in fascicle 0.10.3–0.12.6: `flow_structure` and
  `run_end` events, `turn_retry`, and full per-turn records. Nothing in volley
  depends on their size.
