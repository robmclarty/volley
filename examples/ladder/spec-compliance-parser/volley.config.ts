// Capability-ladder probe: spec-compliance-parser. Implement a Roman-numeral
// codec (both directions) to an exact spec whose teeth are in the edge cases:
// subtractive notation, the 1–3999 range, and — for the parser — rejecting
// every malformed form (too many repeats, illegal subtractive pairs, the empty
// string, lowercase). Probes whether a builder honors a precise spec including
// its negative space, not just the happy path.
//
// Seats: qwen3.6 builds, glm-4.7-flash judges (v3 finding). Sweep with
// `volley matrix` (../README.md). Dependency-free `node --test` gate.
//
// Dry-run from the repo root:
//   VOLLEY_ALLOW_UNSANDBOXED_BUILDER=1 volley \
//     --config examples/ladder/spec-compliance-parser/volley.config.ts --dry-run
import type { VolleyConfig } from 'volley';

const config: VolleyConfig = {
  prompt:
    'Implement roman.mjs exporting toRoman(n) and fromRoman(text) for Roman ' +
    'numerals 1–3999, exactly to the acceptance criteria. Pay special attention ' +
    'to the rejections: fromRoman must throw a SyntaxError on every malformed ' +
    'numeral (too many repeats, illegal subtractive pairs, the empty string, ' +
    'lowercase, non-Roman characters), and toRoman must throw a RangeError ' +
    'outside 1–3999 or on a non-integer. roman.test.mjs enforces the spec and ' +
    'currently fails (roman.mjs does not exist yet). Run `node --test` from the ' +
    'workspace root; it must exit 0 before you finish.',
  workspace: './examples/ladder/spec-compliance-parser/workspace',
  criteria: '@./examples/ladder/spec-compliance-parser/criteria.md',
  check: 'node --test',
  critic: 'reviewer',
  builder_provider: 'ollama',
  builder_model: 'qwen3.6:latest',
  critic_provider: 'ollama',
  critic_model: 'glm-4.7-flash:latest',
  max_iterations: 7,
  max_cost_usd: 10,
};

export default config;
