#!/usr/bin/env node
/**
 * test-writing-seat check gate: mutation testing without a dependency. Runs the
 * builder's `stack.test.mjs` against the real `stack.mjs` (must pass) and against
 * each planted mutant in `mutants/` (must fail). A mutant that survives means the
 * suite is missing the behavior that mutant breaks. Each swap runs in its own
 * temp dir so the workspace is never mutated.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TEST = 'stack.test.mjs';
const SOURCE = 'stack.mjs';
const MUTANTS_DIR = 'mutants';

if (!existsSync(resolve(TEST))) {
  console.log(`FAIL: ${TEST} not found — write the test suite`);
  process.exit(1);
}

/** Run the builder's suite in a throwaway dir with `source_file` as stack.mjs.
 *  Returns true iff `node --test` exits 0 (the suite passes). */
function suite_passes(source_file) {
  const dir = mkdtempSync(join(tmpdir(), 'stack-seat-'));
  try {
    copyFileSync(resolve(TEST), join(dir, TEST));
    copyFileSync(source_file, join(dir, SOURCE));
    return spawnSync(process.execPath, ['--test'], { cwd: dir, stdio: 'ignore' }).status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const failures = [];

// 1. The suite must pass against the correct module.
if (!suite_passes(resolve(SOURCE))) {
  failures.push(`the suite fails against the correct ${SOURCE} — it must pass there first`);
}

// 2. The suite must fail against every mutant (each one is caught).
const mutants = existsSync(resolve(MUTANTS_DIR))
  ? readdirSync(resolve(MUTANTS_DIR))
      .filter((f) => f.endsWith('.mjs'))
      .sort()
  : [];
for (const m of mutants) {
  if (suite_passes(join(resolve(MUTANTS_DIR), m))) {
    failures.push(
      `mutant ${MUTANTS_DIR}/${m} survived — the suite passes against it; add a test that catches this bug`,
    );
  }
}

if (failures.length > 0) {
  for (const f of failures) console.log(`FAIL: ${f}`);
  process.exit(1);
}
console.log(`ok: suite passes on ${SOURCE} and catches all ${mutants.length} mutants`);
