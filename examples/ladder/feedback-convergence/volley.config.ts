// Capability-ladder probe: feedback-convergence. The prompt is deliberately
// one vague line; the acceptance criteria (criteria.md) are exacting — canonical
// formatting, exact error *types*, round-trip identity. A first draft almost
// always misses a few of these, so the probe measures whether the loop
// converges: the check gate fails, the critic echoes the specific `unmet_criteria`,
// the builder revises from that feedback. A model that reads and honors precise
// critic notes converges in a few iterations; one that thrashes never lands.
//
// Seats: qwen3.6 builds, glm-4.7-flash judges (v3 finding). The critic seat is
// the interesting variable here — sweep it with `volley matrix` (../README.md).
//
// Dry-run from the repo root:
//   VOLLEY_ALLOW_UNSANDBOXED_BUILDER=1 volley \
//     --config examples/ladder/feedback-convergence/volley.config.ts --dry-run
import type { VolleyConfig } from '@robmclarty/volley';

const config: VolleyConfig = {
  prompt:
    'Write a small, dependency-free library for working with human-readable ' +
    'durations. Put it in duration.mjs at the workspace root. Run ' +
    '`node check.mjs` from the workspace root before you finish; it must exit 0.',
  workspace: './examples/ladder/feedback-convergence/workspace',
  criteria: '@./examples/ladder/feedback-convergence/criteria.md',
  check: 'node check.mjs',
  critic: 'reviewer',
  builder_provider: 'ollama',
  builder_model: 'qwen3.6:latest',
  critic_provider: 'ollama',
  critic_model: 'glm-4.7-flash:latest',
  max_iterations: 7,
  max_cost_usd: 10,
};

export default config;
