// Coverage-completeness loop: the researcher critic approves when the
// research goal is adequately covered, even if more depth is always possible.
// Run: volley --config examples/researcher/volley.config.ts
import type { VolleyConfig } from 'volley';

const config: VolleyConfig = {
  prompt:
    'Survey approaches to incremental parsing (tree-sitter, Lezer, hand-rolled). ' +
    'Write findings to notes/incremental-parsing.md with a comparison table and a recommendation.',
  workspace: './examples/researcher/workspace',
  criteria: [
    '- each approach summarized with strengths, weaknesses, and maturity',
    '- comparison table present',
    '- recommendation with explicit tradeoffs',
    '- open questions listed',
  ].join('\n'),
  check: 'none',
  critic: 'researcher',
  max_iterations: 4,
  max_cost_usd: 8,
};

export default config;
