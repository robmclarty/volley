// Capability-ladder probe: test-writing-seat. Invert the usual job — the code
// (stack.mjs) is correct and off-limits; the builder's task is to WRITE the test
// suite. A vacuous suite ("it constructs") would pass against the real module,
// so the gate raises the bar with mutation testing: it runs the builder's
// stack.test.mjs against the real stack.mjs (must pass) AND against each planted
// mutant in mutants/ (must FAIL). A mutant that survives means the suite missed
// a behavior. Probes whether a builder writes tests that actually pin behavior,
// not tests that merely execute.
//
// Seats: qwen3.6 builds, glm-4.7-flash judges (v3 finding). The builder seat is
// the one under test here — sweep it with `volley matrix` (../README.md).
//
// Dry-run from the repo root:
//   VOLLEY_ALLOW_UNSANDBOXED_BUILDER=1 volley \
//     --config examples/ladder/test-writing-seat/volley.config.ts --dry-run
import type { VolleyConfig } from '@robmclarty/volley';

const config: VolleyConfig = {
  prompt:
    'stack.mjs in this workspace is a correct, bounded LIFO stack — do NOT edit ' +
    'it or anything under mutants/. Write stack.test.mjs (using node:test, ' +
    "importing from './stack.mjs') that thoroughly pins its behavior: sizing, " +
    'LIFO order, the capacity limit, and the errors thrown on empty pop/peek and ' +
    'on a full push — and that peek does not mutate the stack. The gate runs your ' +
    'suite against the real module (must pass) and against each planted mutant ' +
    '(must fail — a surviving mutant means your suite missed a behavior). Run ' +
    '`node check.mjs` from the workspace root; it must exit 0 before you finish.',
  workspace: './examples/ladder/test-writing-seat/workspace',
  criteria: '@./examples/ladder/test-writing-seat/criteria.md',
  check: 'node check.mjs',
  critic: 'reviewer',
  builder_provider: 'ollama',
  builder_model: 'qwen3.6:latest',
  critic_provider: 'ollama',
  critic_model: 'glm-4.7-flash:latest',
  max_iterations: 6,
  max_cost_usd: 10,
};

export default config;
