// all-Claude — the v3 comparison baseline. Builder AND critic run on Claude via
// the `claude_cli` provider, on the host, with NO Docker (C4/D10): the CLI has
// its own permission model, so volley never containerizes it.
//
// Paired with examples/all-local: identical task, criteria, checkride gate, and
// caps — only the model + transport (and containment) differ. Running both and
// diffing their `.volley/summary.json` `comparison` blocks isolates model-vs-
// transport (verification §4).
//
// Run (host, no Docker):
//   pnpm install --ignore-workspace           # once, inside ./workspace
//   volley --config examples/all-claude/volley.config.ts
//
// The workspace ships a minimal checkride.config.json (types + test), so
// `check: 'auto'` gates the builder on `tsc` + `vitest`. See ./README.md.
import type { VolleyConfig } from 'volley';

const config: VolleyConfig = {
  prompt:
    'Create src/slug.ts exporting slugify(text: string): string — lowercase, trim, ' +
    'collapse runs of whitespace and punctuation to single hyphens, and strip ' +
    'diacritics — plus a Vitest test src/slug.test.ts covering the behavior and edge cases.',
  workspace: './examples/all-claude/workspace',
  criteria: [
    '- src/slug.ts exists and exports slugify',
    '- slugify("Héllo,  World!") === "hello-world"',
    '- edge cases covered: empty string, leading/trailing separators',
    '- a Vitest test (src/slug.test.ts) demonstrates the above and passes',
  ].join('\n'),
  check: 'auto',
  critic: 'reviewer',
  builder_provider: 'claude_cli',
  builder_model: 'sonnet',
  critic_provider: 'claude_cli',
  critic_model: 'sonnet',
  max_iterations: 6,
  max_cost_usd: 10,
};

export default config;
