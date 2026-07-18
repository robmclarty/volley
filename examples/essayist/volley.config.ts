// Essayist — critic-swap generality (Q1): the same loop that reviews code,
// judging prose. The critic seat runs a custom editor prompt (./critic.md)
// against rubric criteria (./rubric.md); the check gate is a dependency-free
// node script (D10) enforcing the mechanical floor (word count, structure,
// citations-present) so the critic spends its judgment on thesis and argument.
//
// Seats embody the v3 finding (research/v3-comparison-finding.md): qwen3.6
// writes well but reproducibly dies *as critic* on Ollama's tool-XML parser,
// so it gets the builder seat and the (fast, proven) glm-4.7-flash judges.
// Swap either freely — just keep qwen3.6 out of the critic seat.
//
// Run from the repo root. A local builder is refused unless contained (B′-2) —
// launch inside the sandbox container (see ./README.md) or dry-run first:
//   VOLLEY_ALLOW_UNSANDBOXED_BUILDER=1 volley \
//     --config examples/essayist/volley.config.ts --dry-run
import type { VolleyConfig } from 'volley';

const config: VolleyConfig = {
  prompt: '@./examples/essayist/brief.md',
  workspace: './examples/essayist/workspace',
  criteria: '@./examples/essayist/rubric.md',
  check: 'node check.mjs',
  critic: './examples/essayist/critic.md',
  builder_provider: 'ollama',
  builder_model: 'qwen3.6:latest',
  critic_provider: 'ollama',
  critic_model: 'glm-4.7-flash:latest',
  max_iterations: 5,
  max_cost_usd: 10,
};

export default config;
