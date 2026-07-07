// Improvement-plateau loop: the optimizer critic approves when further
// iteration would yield diminishing returns, not merely when criteria pass.
// Run: volley --config examples/optimizer/volley.config.ts
import type { VolleyConfig } from 'volley';

const config: VolleyConfig = {
  prompt:
    'Refactor src/ for clarity and performance without changing behavior. ' +
    'Existing tests define the behavior contract.',
  workspace: './examples/optimizer/workspace',
  criteria: [
    '- behavior unchanged: the check pipeline stays green',
    '- no dead code, no needless abstraction layers',
    '- hot paths free of accidental quadratic work',
  ].join('\n'),
  check: 'auto',
  critic: 'optimizer',
  critic_model: 'sonnet',
  max_iterations: 6,
  max_cost_usd: 10,
};

export default config;
