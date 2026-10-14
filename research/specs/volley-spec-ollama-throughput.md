# volley — Ollama throughput spec (issue #1)

A plan-ready specification for closing
[volley#1](https://github.com/robmclarty/volley/issues/1), "Ollama seats never
stream thinking, so throughput's 'decode' rate is a ceiling on fascicle
0.12.10". Since the issue was filed, its cause on volley's transport has been
fixed upstream in ai-sdk-ollama 4.3.0, and a live repro on 2026-10-08 confirmed
it. What's left for volley:

- make sure consumers actually run 4.3.0 or later;
- check the fix on a real volley run;
- mark the gap that remains;
- pick up fascicle's fix for that gap,
  [fascicle#12](https://github.com/robmclarty/fascicle/issues/12), when it
  ships.

Everything true in [`volley-spec-v2.md`](./volley-spec-v2.md) and
[`volley-spec-v3-reconciled.md`](./volley-spec-v3-reconciled.md) carries forward.

---

## What changed since the issue

- **ai-sdk-ollama 4.3.0 (2026-09-09)** surfaces `message.thinking` as AI SDK
  reasoning "independently of the request's `think` setting" (its changelog).
  4.4.0 (2026-09-30) keeps that. fascicle maps `reasoning-delta` to a dispatched
  `reasoning` chunk, so the first-chunk stamp lands on the first thinking token.
- **volley's own lockfile has resolved 4.3.0 since `e150f9e` (2026-09-24).** The
  issue's run (night-shift, `318b81ca`) resolved 4.0.0 in the *consuming*
  project. volley doesn't ship ai-sdk-ollama; consumers install it themselves
  (`README.md:323-327`).
- **fascicle 0.12.13, volley's pin, hasn't changed the relevant code.**
  `throughput()` and both Ollama adapters still behave as #1 describes.

### Live evidence (2026-10-08)

Setup: fascicle 0.12.13, ai-sdk-ollama 4.3.0, Ollama 0.33.3, on an M1 Pro. Each
turn is forced to a single tool call carrying a 120-word paragraph. "Ollama
rate" is output tokens divided by the step's own
`provider_reported.ollama.eval_duration`. The full table and the script are in
fascicle#12.

| transport | model | first chunk | `first_chunk_ms` / `duration_ms` | `throughput()` | Ollama rate |
|---|---|---|---|---|---|
| ai_sdk | qwen3:8b (thinking, `think` unset) | `reasoning` | 1,117 / 28,087 | 20.1 decode | 20.0 |
| ai_sdk | qwen3:4b-instruct-2507 (non-thinking) | `tool_call_end` | 5,474 / 5,477 | 59,666.7 decode | 36.8 |

Row 1 is #1's scenario on volley's transport, and it is fixed.

Row 2 is the gap that remains: a turn whose only output is a tool call. Ollama
sends tool calls whole, so nothing is dispatched until generation is done, and
`throughput()` divides the turn's tokens by its last 3 ms.

The native transport has the same gap, and it also drops thinking entirely, with
`think` unset or `true` (fascicle#12). That's one more reason the native switch
stays on hold.

---

## Baseline

| Area | State | Consequence |
|---|---|---|
| ai-sdk-ollama in volley | `devDependencies` only, exact `4.3.0` | volley's tests use 4.3.0; consumers bring their own copy. |
| What consumers are told | `README.md:320` and `:324` say `ai-sdk-ollama@^4`. `:326-327` say a bare install "is exactly what this major wants". | `^4` admits 4.0.0–4.2.x, which reproduce #1. |
| fascicle's peer | `ai-sdk-ollama: ^4.0.0`, optional | fascicle sets no floor either. |
| Throughput source | `phase_record` passes fascicle's `throughput()` through (`src/cost.ts:46`) into `PhaseRecord` and the iteration archive (`src/iteration.ts:74`). | volley reports whatever fascicle computes. |
| Throughput docs | `src/types.ts:235-241` says `decode` means every turn streamed. | True, but misleading for Ollama tool-only turns. |
| Live coverage | `live_local_builder` (`test/integration/live_smoke.test.ts:73`) defaults to `qwen3-coder:30b`, a non-thinking model. It asserts nothing about throughput or reasoning. | It wouldn't have caught #1, and a throughput check would fail on it today. |

---

## O1 — Hold consumers to ai-sdk-ollama ≥ 4.3.0

**Priority: highest.** This is the fix for #1 in consuming projects.

### Problem

volley never sets `think`, and on `ai_sdk` it can't (see "Not doing"). Thinking
streams only because ai-sdk-ollama ≥ 4.3.0 forwards it without being asked. Any
older 4.x silently brings #1 back: no reasoning in the terminal or the
trajectory, and a `decode` rate well above the real one. Nothing in volley's
install contract excludes those versions.

### Approach

1. **Declare the floor as an optional peer** in `package.json`:

   ```json
   "peerDependencies": { "ai-sdk-ollama": "^4.3.0" },
   "peerDependenciesMeta": { "ai-sdk-ollama": { "optional": true } }
   ```

   Because it's optional, claude_cli-only consumers install nothing and see
   nothing. A consumer with an out-of-range copy gets the package manager's peer
   complaint at install time. Keep the exact `4.3.0` devDependency for volley's
   own tests, per the exact-pin house style.
2. **README (`:318-327`).**
   - Change `ai-sdk-ollama@^4` to `ai-sdk-ollama@^4.3.0` in the table and the
     install line.
   - Replace the "exactly what this major wants" sentence with the reason for
     the floor. Earlier 4.x releases stream a thinking model's reasoning only
     when `think` is set, and volley never sets it. So the reasoning disappears
     from the terminal and the trajectory, and the phase's throughput reads high.
   - Note that a bare `pnpm add ai-sdk-ollama` installs 4.4.0 today, which
     satisfies the floor.
3. **`fallow.toml:16-18`.** Update the comment ("fascicle peers: fascicle loads
   them, volley never does") to say volley now declares ai-sdk-ollama's floor as
   an optional peer. It stays in `ignoreDependencies`.

### Acceptance

- `pnpm check` is green, and the `pnpm pack` tarball's `package.json` carries
  the peer and its meta.
- Scratch consumer: a temp project that installs the packed tarball.
  - With `ai-sdk-ollama@4.0.0`, pnpm reports the unmet peer. Record what npm
    does too (warning or `ERESOLVE`).
  - With 4.3.0 or 4.4.0, the install is silent.
  - Without ai-sdk-ollama, the install is silent.
- The README states the floor and why.

### Open question

Should ai-sdk-ollama ship as a regular dependency instead, with an exact pin like
`ai`?

- **For:** Ollama would work out of the box, including `npx` and global
  installs, where a peer the consumer installed can't be seen at all. volley
  would also control the version outright.
- **Against:** every install pulls it, including claude_cli-only users. It
  changes the README's "install the peer for your provider" contract, and raises
  the same question for `@ai-sdk/openai-compatible`. Under npm, a consumer's own
  older copy could still be the one fascicle resolves.

Recommendation: use the optional peer now, and revisit if `npx` or global Ollama
use becomes a goal.

---

## O2 — Confirm on a volley run, then close #1

### Approach

1. Run volley with a thinking model in both seats on ai-sdk-ollama ≥ 4.3.0. For
   example, run `live_local_builder` with `VOLLEY_LIVE=1
   VOLLEY_LIVE_BUILDER_PROVIDER=ollama VOLLEY_LIVE_BUILDER_MODEL=qwen3:8b`, or
   one iteration against reckon.
2. Check the run.
   - `.volley/trajectory.jsonl` holds `model_chunk` events with
     `chunk.kind: "reasoning"` for both the builder and the critic. fascicle's
     `model_call` records every chunk when the run streams.
   - Each phase's `throughput` in `.volley/iterations/001/summary.json` is within
     about 20% of the model's eval rate from a direct `/api/chat` probe
     (`eval_count / eval_duration`, as #1 measured it).
   - If a phase reads high, look for turns with no reasoning chunk before their
     tool call. Those are fascicle#12's case, not a regression of #1.
3. Close #1 with a comment. Thinking seats are fixed by ai-sdk-ollama ≥ 4.3.0,
   whose floor O1 now declares. The tool-only gap is tracked in fascicle#12.
   Include the run's numbers.

### Acceptance

The checks in step 2 pass on one run, and the numbers are in #1's closing
comment.

---

## O3 — Mark the gap where volley documents throughput

### Problem

Until fascicle#12 ships, any Ollama turn whose only output is a tool call reports
`basis: 'decode'` over its last few milliseconds.

- On a non-thinking seat, that's most builder turns, so the phase rate means
  nothing. Examples are `qwen3-coder:30b`, the live test default, and
  `qwen3:4b-instruct-2507`.
- Thinking seats on 4.3.0 are fine, unless a turn skips thinking.

### Approach

Docs only, with no workaround in code.

1. **`src/types.ts:235-241` (`PhaseRecord.throughput`).**
   - On Ollama, a turn that emits only a tool call dispatches nothing until the
     call is complete. So `decode` overstates the rate on non-thinking seats
     until fascicle#12.
   - Thinking seats need ai-sdk-ollama ≥ 4.3.0 for the rate to hold.
2. **`src/engine.ts:105-114` (the on-hold native switch).** Note that the native
   transport drops `message.thinking` today (fascicle#12). Switching would
   therefore lose reasoning from the terminal and the trajectory, on top of
   changing the comparison variable.
3. **Release note** (the `/version` changelog entry). Add one line on the floor
   and the caveat. Leave v0.5.3's "true decode rate" entry as shipped.

### Acceptance

The comments are updated and `pnpm check` is green.

---

## O4 — Adopt fascicle#12's fix

When fascicle ships a fix:

1. Bump fascicle, and the exact ai-sdk-ollama devDependency if fascicle's peer
   range moves.
2. Rewrite O3's caveats to describe the new behavior, for example that Ollama
   steps are timed by the daemon's `eval_duration`. If native now streams
   thinking, say so in `src/engine.ts`.
3. Update the throughput case in `test/unit/cost.test.ts:117` if `Throughput`'s
   shape or `basis` values change.
4. Add a sanity check to `live_local_builder`: every phase's
   `throughput.tokens_per_second` stays under a ceiling no local model reaches,
   such as 500 tok/s.

### Acceptance

`live_local_builder` passes with the new check on a non-thinking model (the
`qwen3-coder:30b` default) and on a thinking one (`qwen3:8b`).

---

## Suggested order

1. O1 and O3 together: one small change covering `package.json`, the README,
   the `fallow.toml` comment, and two doc comments.
2. O2: the live run, then close #1.
3. O4 when fascicle#12 ships.

## Whole-spec verification

- `pnpm check` is green after O1 and O3.
- O1's scratch-consumer results are recorded for both pnpm and npm.
- O2's live-run numbers are in #1's closing comment.
- After O4, `live_local_builder`'s new check passes on a non-thinking model and
  a thinking one.

## Noticed, deliberately out of scope

- **Setting `think` from volley.**
  - On `ai_sdk` there's no way to do it. ai-sdk-ollama reads `think` only from
    model settings or the AI SDK's per-call `reasoning` option, and fascicle
    passes neither: it builds `createOllama({ baseURL })(model_id)`, and
    `translate_ollama_effort` drops effort.
  - On native, `provider_options.ollama.think` reaches the daemon, but the
    reasoning is dropped on the way back (fascicle#12).
  - With ≥ 4.3.0 the metric doesn't need it.
- **`think: false` on the critic for speed.**
  - In #1, the critic's first chunk came 27.4s into a 28.0s call.
  - In the repro, `think: false` cut qwen3:8b's output by more than half (529 to
    233 tokens).
  - Worth trying as its own experiment, weighing verdict quality against speed.
    It needs a way to pass `think` through fascicle on `ai_sdk` first.
- **Computing Ollama throughput in volley** from
  `provider_reported.ollama.eval_duration`. That's the first fix fascicle#12
  suggests. A volley copy would drift from `throughput()`.
- **Switching to the native transport.** It stays on hold, and native currently
  drops thinking.
- **LM Studio.** Not examined. Whether `@ai-sdk/openai-compatible` streams
  reasoning and tool-call deltas from LM Studio is unverified, and the same
  version-floor question applies to that peer.
