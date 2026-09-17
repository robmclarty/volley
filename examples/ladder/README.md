# capability-ladder examples

Seven probe workspaces, each isolating one capability that separates a strong
builder×critic pairing from a weak one. They are **runnable repo artifacts**, not
a list in a chat: each has its own workspace seed, `volley.config.ts`, acceptance
`criteria.md`, and a check gate — so you can dry-run it, run it, and (the point)
**sweep it through `volley matrix`** to see which local models clear which rung.

Authoring the ladder is this build's job; *running* the sweeps is post-build
usage. Every probe passes `--dry-run` today.

## The rungs

| Probe | Capability it isolates | Seed → target | Sweep the… |
|---|---|---|---|
| `brownfield-bugfix` | Read unfamiliar code, localize a defect from a failing assertion, fix in place | 3 planted bugs + a failing suite → green | builder |
| `feedback-convergence` | Converge on an exact target from a **vague** prompt via critic feedback | one-line prompt + strict criteria → spec met | critic |
| `cross-file-refactor` | Carry one change coherently across files, not just the first symptom | 2D vector lib across 3 modules → 3D everywhere | builder |
| `step-cap-pressure` | Stay economical under a tight `builder_max_steps` | 5 handlers needing guards, budget 18 → all fixed | builder |
| `dependency-wrangling` | Reach for a real library and integrate it (**online-only**) | empty pkg → `slugify` added + wired | builder |
| `spec-compliance-parser` | Honor a precise spec **including its negative space** | Roman-numeral codec → happy path + every rejection | builder |
| `test-writing-seat` | Write tests that pin behavior, proven by mutation testing | correct `stack.mjs` + mutants → suite catches all | builder |

Each row names the seat worth varying, but nothing stops you sweeping the other —
that is what the matrix is for.

### What each gate checks

All gates are **dependency-free** — `node --test` (the built-in runner) or a plain
`node check.mjs` — so no probe needs an install except `dependency-wrangling`,
which is the whole point of that one:

- `brownfield-bugfix`, `cross-file-refactor`, `step-cap-pressure`,
  `spec-compliance-parser` — a pre-written test suite (`*.test.mjs`) that fails on
  the seed and passes when the task is done.
- `feedback-convergence`, `dependency-wrangling` — a `check.mjs` that asserts the
  behavioral spec (and, for the dependency probe, that `slugify` is actually
  declared and installed — not hand-rolled).
- `test-writing-seat` — a `check.mjs` doing **mutation testing**: it runs the
  builder's suite against the real `stack.mjs` (must pass) and against each planted
  mutant in `mutants/` (must fail). A surviving mutant means the suite missed a
  behavior.

## Default seats

Every config ships the v3 baseline (research/v3-comparison-finding.md): `qwen3.6`
builds, `glm-4.7-flash` (fastest critic tested) judges. **Keep `qwen3.6` out of the
critic seat** — it writes well but reproducibly dies *as critic* on Ollama's
server-side tool-XML parser. The seats are only a starting point; the sweeps below
vary them.

## Prerequisites

- **Ollama** on the host with the models you intend to sweep pulled (`ollama pull
  qwen3.6:latest`, `ollama pull glm-4.7-flash:latest`, and whatever else you name).
- For a real (non-dry) run: a local builder is refused unless contained, so
  launch volley inside its sandbox exactly as `examples/all-local/README.md`
  documents. The workspaces need **no toolchain install** — the gates are plain
  `node` (again, except `dependency-wrangling`).

## Dry-run any probe

From the repo root, prove a probe's config, endpoint, and critic-seat canary before
any spend:

```sh
VOLLEY_ALLOW_UNSANDBOXED_BUILDER=1 volley \
  --config examples/ladder/brownfield-bugfix/volley.config.ts --dry-run
```

Swap the `--config` path for any of the seven. `--dry-run` does not execute the
check gate, so `dependency-wrangling` dry-runs clean offline — its online
requirement bites only on a real run.

## Sweeping a rung with `volley matrix`

`volley matrix` forces a `--worktree` per combo, so each probe's workspace must be
its own git repo. Initialize them once:

```sh
for d in examples/ladder/*/workspace; do
  (cd "$d" && git init -q && git add -A && git commit -qm init)
done
```

Then sweep the seat that rung probes (hold the other fixed). One aggregate table
comes back — pass rate, iterations, wall clock, cost, salvage, and *why* each seat
fell off. Add `--repeat 3` (or more) to every line below if you intend to compare
seats rather than smoke-test them: a rung's answer is "how often does this pairing
clear it", and a single run cannot report a rate.

```sh
# brownfield-bugfix — which builder localizes and fixes?
volley matrix --config examples/ladder/brownfield-bugfix/volley.config.ts \
  --builders qwen3.6:latest,qwen2.5-coder:7b,qwen3:8b --critics glm-4.7-flash:latest

# feedback-convergence — which critic gives feedback good enough to converge on?
volley matrix --config examples/ladder/feedback-convergence/volley.config.ts \
  --builders qwen3.6:latest --critics glm-4.7-flash:latest,qwen3:8b,gemma4:12b

# cross-file-refactor — which builder carries the change across all three files?
volley matrix --config examples/ladder/cross-file-refactor/volley.config.ts \
  --builders qwen3.6:latest,qwen2.5-coder:7b,gemma4:12b --critics glm-4.7-flash:latest

# step-cap-pressure — which builder stays economical under the step cap?
volley matrix --config examples/ladder/step-cap-pressure/volley.config.ts \
  --builders qwen3.6:latest,qwen2.5-coder:7b,qwen3:8b --critics glm-4.7-flash:latest

# dependency-wrangling — ONLINE ONLY (see "The online-only probe" below for how to reach the registry)
volley matrix --config examples/ladder/dependency-wrangling/volley.config.ts \
  --builders qwen3.6:latest,qwen2.5-coder:7b --critics glm-4.7-flash:latest

# spec-compliance-parser — which builder honors the rejections, not just the happy path?
volley matrix --config examples/ladder/spec-compliance-parser/volley.config.ts \
  --builders qwen3.6:latest,qwen2.5-coder:7b,gemma4:12b --critics glm-4.7-flash:latest

# test-writing-seat — which builder writes tests that catch every mutant?
volley matrix --config examples/ladder/test-writing-seat/volley.config.ts \
  --builders qwen3.6:latest,qwen2.5-coder:7b,qwen3:8b --critics glm-4.7-flash:latest
```

A non-converging combo is a **result**, not a crash — it shows up in the table with
the reason it did not converge (the failing check slots, the criteria still unmet, a
cost cap, a gate edit). That is the ladder doing its job: telling you where each
model falls off, and how.

## The online-only probe (dependency-wrangling)

Six of the seven rungs are fully dependency-free and run under the sandbox's
default deny-by-default egress (allowlist to host Ollama only, or `--network
none`). `dependency-wrangling` is the exception on purpose: its whole point is
that the builder must pull `slugify` off the npm registry, so its check gate
fails until the package is declared **and** installed. Its `--dry-run` still
passes offline (dry-run never executes the gate) — the registry requirement bites
only on a real run. Three ways to satisfy it, most-contained first:

1. **Warm the dependency into the pnpm store, then run offline (recommended).**
   This is volley's "warm-then-offline" pattern (see `examples/all-local/README.md`
   for the `volley-pnpm-store` volume). Populate the store once, with egress, then
   the in-sandbox `pnpm add slugify` resolves from the warm store under
   `--network none`:

   ```sh
   # `pnpm store add` populates the store directly, touching no project files
   docker run --rm -v volley-pnpm-store:/home/node/.local/share/pnpm/store \
     --entrypoint pnpm volley-sandbox:latest store add slugify
   ```

2. **Open registry egress for the run.** On **Linux** the L3/L4 egress deny is the
   `DOCKER-USER` rule scoped to `volley-sandbox-net` (`src/sandbox.ts`) — add a
   registry allowlist entry, or run the combo on a plain `--network bridge`. On
   **macOS/Windows** that kernel-level deny isn't enforced (only the in-process
   SSRF deny-list is), so the default `volley-sandbox-net` already reaches the
   registry and `pnpm add` just works.

3. **Run uncontained on a networked host** (least isolated) —
   `VOLLEY_ALLOW_UNSANDBOXED_BUILDER=1`, where `pnpm add slugify` hits the registry
   directly. Fine for a quick local sweep; not for untrusted builder output.

However you get the package in, the gate is the same: `slugify` in `package.json`
`dependencies` and resolvable in `node_modules`, with `slug.mjs` using it.
