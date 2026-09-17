// Local critic: builder on Claude, critic on a free local model via Ollama.
// The recurring per-iteration critic cost drops to zero; the builder — where
// agentic capability matters most — stays on Claude.
//
// Setup: install Ollama, pull a model (`ollama pull qwen3:32b`), and add the
// peer dependency: `pnpm add ai-sdk-ollama`.
//
// Run: volley --config examples/local-critic/volley.config.ts
import type { VolleyConfig } from '@robmclarty/volley';

const config: VolleyConfig = {
  prompt:
    'Create a small TypeScript module src/slug.ts exporting slugify(text: string): string. ' +
    'Lowercase, trim, collapse whitespace and punctuation to single hyphens, strip diacritics.',
  workspace: './examples/local-critic/workspace',
  criteria: [
    '- src/slug.ts exists and exports slugify',
    '- slugify("Héllo,  World!") === "hello-world"',
    '- edge cases covered: empty string, leading/trailing separators',
  ].join('\n'),
  check: 'none',
  critic: 'reviewer',
  critic_provider: 'ollama',
  critic_model: 'qwen3:32b',
  max_iterations: 5,
  max_cost_usd: 5,
};

export default config;
