// Capability-ladder probe: dependency-wrangling. The task can only be done by
// pulling a real package off the registry (`slugify`) and wiring it in — probes
// whether a builder reaches for an existing library and integrates it, rather
// than reinventing it inline. The check gate verifies the dependency is actually
// declared and installed, not just that the output looks right.
//
// ONLINE-ONLY: volley's sandbox egress is deny-by-default (allowlist to
// host Ollama only, or `--network none`), so an in-sandbox `pnpm add` cannot
// reach the npm registry. Run this probe with the sandbox network opened to the
// registry, or uncontained on a host that has network. See ../README.md.
//
// Seats: qwen3.6 builds, glm-4.7-flash judges (v3 finding). Sweep with
// `volley matrix` (../README.md).
//
// Dry-run from the repo root (dry-run does not run the check, so it passes
// offline — the online requirement bites only on a real run):
//   VOLLEY_ALLOW_UNSANDBOXED_BUILDER=1 volley \
//     --config examples/ladder/dependency-wrangling/volley.config.ts --dry-run
import type { VolleyConfig } from '@robmclarty/volley';

const config: VolleyConfig = {
  prompt:
    'Add the `slugify` package (npm) as a dependency of this workspace and use ' +
    'it to implement slug.mjs, which exports `slug(text)` returning a URL slug: ' +
    "lowercase, punctuation stripped, spaces to hyphens, diacritics folded (so " +
    "slug('Héllo, World!') === 'hello-world', slug('Node.js Rocks!') === " +
    "'nodejs-rocks'). Do not reimplement slugification " +
    'by hand — the point is to use the library. Install it with `pnpm add ' +
    'slugify`, then run `node check.mjs` from the workspace root; it must exit 0.',
  workspace: './examples/ladder/dependency-wrangling/workspace',
  criteria: '@./examples/ladder/dependency-wrangling/criteria.md',
  check: 'node check.mjs',
  critic: 'reviewer',
  builder_provider: 'ollama',
  builder_model: 'qwen3.6:latest',
  critic_provider: 'ollama',
  critic_model: 'glm-4.7-flash:latest',
  max_iterations: 5,
  max_cost_usd: 10,
};

export default config;
