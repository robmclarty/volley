// Capability-ladder probe: cross-file-refactor. A vector library split across
// three modules (vec → shapes → physics) is 2D; migrate the whole thing to 3D.
// The test suite (unchanged, 3D) fails until *every* module is updated
// consistently: fixing vec.mjs alone is not enough — shapes.mjs seeds a reduce
// with a 2D literal and physics.mjs constructs a 2D vector, and both must gain a
// z. Probes whether a builder can carry one change coherently across files
// instead of patching the first symptom and stopping.
//
// Seats: qwen3.6 builds, glm-4.7-flash judges (v3 finding). Sweep with
// `volley matrix` (../README.md). Dependency-free `node --test` gate.
//
// Dry-run from the repo root:
//   VOLLEY_ALLOW_UNSANDBOXED_BUILDER=1 volley \
//     --config examples/ladder/cross-file-refactor/volley.config.ts --dry-run
import type { VolleyConfig } from '@robmclarty/volley';

const config: VolleyConfig = {
  prompt:
    'This vector library is 2D. Migrate it to 3D `{ x, y, z }` across all three ' +
    'modules — vec.mjs, shapes.mjs, and physics.mjs. The test suite ' +
    'kinematics.test.mjs already expects 3D and currently fails; do NOT edit it. ' +
    'A z must be threaded through every point the code constructs, not just the ' +
    'core vec.mjs helpers. Run `node --test` from the workspace root; it must ' +
    'exit 0 before you finish.',
  workspace: './examples/ladder/cross-file-refactor/workspace',
  criteria: '@./examples/ladder/cross-file-refactor/criteria.md',
  check: 'node --test',
  critic: 'reviewer',
  builder_provider: 'ollama',
  builder_model: 'qwen3.6:latest',
  critic_provider: 'ollama',
  critic_model: 'glm-4.7-flash:latest',
  max_iterations: 6,
  max_cost_usd: 10,
};

export default config;
