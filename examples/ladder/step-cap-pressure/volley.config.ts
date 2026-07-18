// Capability-ladder probe: step-cap-pressure. Five handler modules each need the
// same small thing — an argument-validation guard — and `builder_max_steps` is
// set deliberately tight (18). The irreducible work is ~5 reads + 5 edits + a
// check run, so a builder that plans (reads once, edits precisely, runs the
// gate last) finishes inside the cap; one that thrashes — re-reading files,
// running `node --test` after every edit — exhausts the budget and the summary
// shows a partial fix. Probes step efficiency under pressure, not raw ability.
//
// Seats: qwen3.6 builds, glm-4.7-flash judges (v3 finding). Sweep builders with
// `volley matrix` to see which models stay economical (../README.md).
//
// Dry-run from the repo root:
//   VOLLEY_ALLOW_UNSANDBOXED_BUILDER=1 volley \
//     --config examples/ladder/step-cap-pressure/volley.config.ts --dry-run
import type { VolleyConfig } from 'volley';

const config: VolleyConfig = {
  prompt:
    'Each of the five modules in handlers/ performs a store operation with NO ' +
    'argument validation. Add a guard to each so it throws a TypeError on ' +
    'invalid input, exactly as handlers.test.mjs expects (the tests currently ' +
    'fail). Keep every valid-input path working. You have a tight step budget, ' +
    'so plan before you edit: read what you need, make each fix once, and run ' +
    '`node --test` from the workspace root at the end — it must exit 0.',
  workspace: './examples/ladder/step-cap-pressure/workspace',
  criteria: '@./examples/ladder/step-cap-pressure/criteria.md',
  check: 'node --test',
  critic: 'reviewer',
  builder_provider: 'ollama',
  builder_model: 'qwen3.6:latest',
  builder_max_steps: 18,
  critic_provider: 'ollama',
  critic_model: 'glm-4.7-flash:latest',
  max_iterations: 4,
  max_cost_usd: 10,
};

export default config;
