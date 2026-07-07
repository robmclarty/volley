// Acceptance-driven loop: the default reviewer critic gates on the criteria.
// Run: volley --config examples/reviewer/volley.config.ts
import type { VolleyConfig } from 'volley';

const config: VolleyConfig = {
  prompt:
    'Create a small TypeScript module src/slug.ts exporting slugify(text: string): string. ' +
    'Lowercase, trim, collapse whitespace and punctuation to single hyphens, strip diacritics.',
  workspace: './examples/reviewer/workspace',
  criteria: [
    '- src/slug.ts exists and exports slugify',
    '- slugify("Héllo,  World!") === "hello-world"',
    '- edge cases covered: empty string, leading/trailing separators',
    '- a runnable test demonstrates the above',
  ].join('\n'),
  check: 'none',
  critic: 'reviewer',
  max_iterations: 5,
  max_cost_usd: 5,
};

export default config;
