#!/usr/bin/env node
/**
 * dependency-wrangling check gate (ONLINE-ONLY, D10). Verifies the builder
 * genuinely pulled in `slugify` rather than hand-rolling it: the package must be
 * declared in package.json AND installed, and slug.mjs must behave. Offline this
 * fails at the install check by design — the ladder README discloses that this
 * probe needs registry access.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const failures = [];
const require = createRequire(import.meta.url);

// 1. Declared as a dependency (not devDependencies, not just installed ad hoc).
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
if (!pkg.dependencies || !pkg.dependencies.slugify) {
  failures.push('slugify is not listed under "dependencies" in package.json');
}

// 2. Actually installed (this is the check that fails offline).
let installed = true;
try {
  require.resolve('slugify');
} catch {
  installed = false;
  failures.push('slugify is not installed — run the build online: `pnpm add slugify`');
}

// 3. slug.mjs exists and behaves (only worth importing if the dep resolves).
if (!existsSync(resolve('slug.mjs'))) {
  failures.push('slug.mjs not found at the workspace root');
} else if (installed) {
  const { slug } = await import(pathToFileURL(resolve('slug.mjs')).href);
  if (typeof slug !== 'function') {
    failures.push('slug.mjs must export a function `slug`');
  } else {
    const cases = [
      ['Héllo, World!', 'hello-world'],
      ['Node.js Rocks!', 'nodejs-rocks'],
      ['', ''],
    ];
    for (const [input, expected] of cases) {
      let actual;
      try {
        actual = slug(input);
      } catch (err) {
        failures.push(`slug(${JSON.stringify(input)}) threw ${err?.constructor?.name ?? 'Error'}`);
        continue;
      }
      if (actual !== expected) {
        failures.push(`slug(${JSON.stringify(input)}) === ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
      }
    }
  }
}

if (failures.length > 0) {
  for (const f of failures) console.log(`FAIL: ${f}`);
  process.exit(1);
}
console.log('ok: slugify wired in and slug.mjs behaves');
