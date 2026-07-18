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
- For a real (non-dry) run: a local builder is refused unless contained (B′-2), so
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

Then sweep the seat that rung probes (hold the other fixed). One aggregate table —
iterations, wall clock, salvage rate, degraded flag — comes back per combo:

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

# dependency-wrangling — ONLINE ONLY: run with the sandbox network opened to the registry
volley matrix --config examples/ladder/dependency-wrangling/volley.config.ts \
  --builders qwen3.6:latest,qwen2.5-coder:7b --critics glm-4.7-flash:latest

# spec-compliance-parser — which builder honors the rejections, not just the happy path?
volley matrix --config examples/ladder/spec-compliance-parser/volley.config.ts \
  --builders qwen3.6:latest,qwen2.5-coder:7b,gemma4:12b --critics glm-4.7-flash:latest

# test-writing-seat — which builder writes tests that catch every mutant?
volley matrix --config examples/ladder/test-writing-seat/volley.config.ts \
  --builders qwen3.6:latest,qwen2.5-coder:7b,qwen3:8b --critics glm-4.7-flash:latest
```

A non-converging combo is a **result**, not a crash — it shows up in the table. That
is the ladder doing its job: telling you where each model falls off.
