// Capability-ladder probe: brownfield-bugfix. Fix planted bugs in existing
// code so a pre-written, currently-failing test suite goes green — without
// touching the tests or changing signatures. Probes whether a builder can read
// unfamiliar code, localize a defect from a failing assertion, and make a
// minimal in-place fix (not a rewrite).
//
// Seats follow the v3 finding (research/v3-comparison-finding.md): qwen3.6
// builds, glm-4.7-flash (proven, fast) judges — keep qwen3.6 out of the critic
// seat. Sweep either with `volley matrix` (see ../README.md).
//
// Dependency-free gate: `node --test` runs the built-in test runner over
// `cart.test.mjs`; no install, no toolchain beyond node.
//
// Run from the repo root. A local builder is refused unless contained (B′-2) —
// dry-run first, then run inside the sandbox (see ../README.md):
//   VOLLEY_ALLOW_UNSANDBOXED_BUILDER=1 volley \
//     --config examples/ladder/brownfield-bugfix/volley.config.ts --dry-run
import type { VolleyConfig } from 'volley';

const config: VolleyConfig = {
  prompt:
    'cart.mjs in this workspace has three planted bugs. Its test file ' +
    'cart.test.mjs documents the intended behavior and currently fails. Fix ' +
    'cart.mjs so every test passes. Do NOT edit cart.test.mjs, and do NOT ' +
    'change the exported function names or signatures — the bugs are in the ' +
    'function bodies. Run `node --test` from the workspace root; it must exit ' +
    '0 before you finish.',
  workspace: './examples/ladder/brownfield-bugfix/workspace',
  criteria: '@./examples/ladder/brownfield-bugfix/criteria.md',
  check: 'node --test',
  critic: 'reviewer',
  builder_provider: 'ollama',
  builder_model: 'qwen3.6:latest',
  critic_provider: 'ollama',
  critic_model: 'glm-4.7-flash:latest',
  max_iterations: 5,
  max_cost_usd: 10,
};

export default config;
