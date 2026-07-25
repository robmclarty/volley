# reckon — first multi-module real-work target, all-local, one iteration

*The ladder probes and the v3 comparison both ran single-file tasks. `reckon`
(`../reckon`) is the first cross-file target: four modules with a real
dependency order, a precise spec with negative space, and a dependency-free
`node --test` gate. This records what the all-local seat pairing did with it,
what was verified by hand afterwards rather than taken from the run's own
report, and the confounds that keep the result honest. Numbers quote
`.volley/summary.json` from run `17ce211c` (run state is gitignored, so they are
reproduced here).*

## The task

reckon is a plaintext double-entry ledger — a small subset of the
ledger/hledger format. The spec (`docs/spec.md`) was written first, the test
suite was written and failing, and the four `src/` modules were stubs throwing
`not implemented`:

| module | responsibility |
|---|---|
| `src/amount.mjs` | `parseAmount` / `formatAmount`, integer cents, knows nothing about journals |
| `src/parse.mjs` | journal syntax → transactions, purely syntactic, no balancing |
| `src/ledger.mjs` | `balance` / `accountBalances` / `register`, owns all inference and aggregation |
| `src/cli.mjs` | `main(argv)` — thin formatting and exit-code shell |

The gate is `node --test` (29 tests) exiting 0, plus a critic review against
`volley/criteria.md`, which restates the module boundaries, the
no-third-party-dependencies rule, `balance`'s non-mutation, and integer-cent
money.

## Setup

| | |
|---|---|
| builder | `ollama` / `qwen3.6:latest` (23 GB), `builder_max_steps: 60` |
| critic | `ollama` / `glm-4.7-flash:latest` (19 GB), `reviewer` preset |
| transport | `ai_sdk` both seats (fascicle → `ai-sdk-ollama`) |
| containment | **uncontained on the host** (`VOLLEY_ALLOW_UNSANDBOXED_BUILDER=1`) over a per-run git worktree |
| worktree fate | `salvage` — `worktree: true`, no `git_checkpoints` (volley 0.4.1) |
| caps | `max_iterations: 8`, `max_cost_usd: 10` |
| environment | macOS 26.5.2 (Darwin 25.5.0), MacBook Pro 18,3, **32 GiB**, Ollama 0.30.10, Node v24.15.0, volley 0.4.1 |
| context window | 32768 (Ollama server default; neither model declares `num_ctx`) |

Note the memory: reckon's README sizes the pairing for a 48 GB Mac mini, but
this ran on 32 GiB. 23 GB + 19 GB cannot co-reside, so the builder and critic
models swap between phases — a plausible contributor to wall clock that was not
separately measured.

## Result — converged on iteration 1

| | |
|---|---|
| status | success, verdict **approved**, `critic_degraded: false` |
| iterations to converge | **1** |
| wall clock | 771,265 ms (12 m 51 s), including cold model loads |
| cost | **$0.000** (both seats local) |
| tokens | 278,115 in / 8,358 out (cumulative across steps, not one context) |
| builder tool calls | 36 |
| local salvage rate | **0** — 0 of 36 tool calls needed client-side salvage |
| check | ran once, ok, 1,583 ms |
| result branch | `volley/17ce211c-23a1-4bb4-a362-826339e1828a` (commit `e9b94bf`) |

The zero salvage rate is the notable transport number. The failure mode
documented in `ollama-qwen-parser-issue.md` — a malformed qwen tool call killing
the stream — did not occur once across 36 calls.

## Independent verification

The run's own report is not evidence that the work is correct; volley's check
and its critic both examined the same tree. Checked afterwards on a clean
checkout of the result branch, in a throwaway worktree:

- `node --test` → **29/29 pass**, exit 0.
- The salvage commit touches **only** the four `src/*.mjs` modules. No test
  file, fixture, or `package.json` was modified — the builder did not edit the
  gate to make it pass. This is the check worth running every time a local
  builder reports green.
- No `not implemented` remains anywhere in `src/`.
- Money stays integral: `parseInt(intPart, 10) * 100` and
  `Math.floor(abs / 100)`; no `parseFloat`, `toFixed`, or float division
  anywhere in `src/`.
- CLI exercised by hand against the fixtures: `balance` produces correct
  ancestor roll-ups (`Assets` 1957.50 alongside `Assets:Checking` 1957.50),
  `register`'s running total returns to 0.00 after each balanced transaction,
  and the unbalanced fixture writes to stderr and exits 1.

### The one defect the gate did not catch

`src/ledger.mjs:41` embeds the line number in the `BalanceError` message, and
`cli.mjs` then appends it again per spec §4's `error: <message> (line <n>)`:

```
error: postings do not sum to zero at line 1 (line 1)
```

The CLI side is spec-correct; the redundancy is in the ledger message. The
tests assert the error *type* and never its text, so nothing failed — and the
critic, reviewing against criteria that say nothing about message wording,
approved. A defect that lives in the gap between an executable spec and a
natural-language one is exactly what the two-gate design is supposed to catch,
and here neither gate was aimed at it.

## What this exercised in the harness

- **The salvage path's first real run.** volley 0.4.1's `worktree_fate()`
  resolved to `salvage`, teardown committed the builder's tree onto
  `volley/<run_id>` and kept the branch, and the orchestrator named it on
  stdout and in `.volley/summary.json`. Under 0.4.0 this run's output would have
  been force-deleted at teardown.
- **The predict-then-warn notice fired** at run start, naming the fate before
  any spend.
- **Worktree isolation held.** The workspace stayed clean at `a9685ad` with its
  stubs intact throughout, despite an uncontained builder with real host `bash`.

## Confounds

Read the one-iteration convergence narrowly:

- **The scaffold is strong.** The spec was precise and the 29 tests were written
  first, so the model was completing a well-specified shape, not designing one.
  A from-scratch task with the same module count would be a different result.
- **The prompt named the build order** (`amount` → `parse` → `ledger` → `cli`)
  and told the builder to run `node --test` as it went. Some of the
  decomposition that a builder would otherwise have to find was given to it.
- **n = 1, one seat pairing.** No matrix sweep, no repeat run. Nothing here says
  qwen3.6 converges on this task reliably, only that it did once.
- **The critic's approval is weak evidence.** It agreed with the check and with
  the by-hand verification, which is reassuring, but a critic reading criteria
  it cannot fail against is not an independent oracle — see the missed
  double-line-number defect.
- **Cold-load time is inside the wall clock**, and the 32 GiB ceiling forces a
  model swap between the builder and critic phases. 12 m 51 s is not a clean
  inference-time measurement.

## Follow-ups

- Sweep the seats (`volley matrix --builders … --critics …`, which forces
  `discard_worktree` per seat) to find the weakest builder that still converges
  on reckon, and whether any critic catches the message defect.
- Tighten `volley/criteria.md` to pin user-facing error text, then re-run: does
  a criteria-only change surface a defect the executable gate structurally
  cannot see?
- Re-run on the 48 GB machine reckon's README targets, to separate model-swap
  cost from inference cost in the wall clock.
