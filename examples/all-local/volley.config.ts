// all-local — the v3 local path. Builder AND critic run on a free local model
// via Ollama on the `ai_sdk` transport (D1/C5), gated by checkride, running
// inside volley's hardened Docker sandbox (B′/D5) over a per-run git worktree
// (s2 D3). The builder's `fetch` tool is enabled; the run targets $0 and — after
// deps are warmed — offline.
//
// Paired with examples/all-claude: identical task, criteria, checkride gate, and
// caps — only the model + transport (and containment) differ. Diff the two
// `.volley/summary.json` `comparison` blocks to isolate model-vs-transport.
//
// Run: launch volley INSIDE its sandbox container. A local builder is refused
// unless volley detects containment (B′-2), so the operator's `docker run` sets
// VOLLEY_CONTAINED=1 and crosses the model endpoint to host.docker.internal.
// The hardened invocation and the ollama / worktree / offline setup are in
// ./README.md (src/sandbox.ts renders the exact `docker run` line).
import type { VolleyConfig } from 'volley';

const config: VolleyConfig = {
  prompt:
    'Create src/slug.ts exporting slugify(text: string): string — lowercase, trim, ' +
    'collapse runs of whitespace and punctuation to single hyphens, and strip ' +
    'diacritics — plus a Vitest test src/slug.test.ts covering the behavior and edge cases.',
  workspace: './examples/all-local/workspace',
  criteria: [
    '- src/slug.ts exists and exports slugify',
    '- slugify("Héllo,  World!") === "hello-world"',
    '- edge cases covered: empty string, leading/trailing separators',
    '- a Vitest test (src/slug.test.ts) demonstrates the above and passes',
  ].join('\n'),
  check: 'auto',
  critic: 'reviewer',
  builder_provider: 'ollama',
  builder_model: 'qwen3:32b',
  critic_provider: 'ollama',
  critic_model: 'qwen3:32b',
  worktree: true,
  max_iterations: 6,
  max_cost_usd: 10,
};

export default config;
