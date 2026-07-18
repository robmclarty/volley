#!/usr/bin/env node
/**
 * Essayist check gate (D10): a dependency-free mechanical floor under the
 * rubric — word count, structure, citations-present. Judgment (thesis,
 * argument, prose quality) belongs to the critic, not this script.
 *
 * The word band is deliberately wider than the brief's 900–1400 ask: the gate
 * fails drafts that are clearly off-spec and leaves the exact range to the
 * critic, so a 1450-word essay iterates on editorial feedback, not a hard gate.
 */
import { existsSync, readFileSync } from 'node:fs';

const ESSAY = 'essay.md';
const MIN_WORDS = 800;
const MAX_WORDS = 1600;
const MIN_SECTIONS = 3;
const MIN_SOURCES = 3;

if (!existsSync(ESSAY)) {
  console.log(`FAIL: ${ESSAY} not found at the workspace root`);
  process.exit(1);
}

const lines = readFileSync(ESSAY, 'utf8').split('\n');
const failures = [];

// Structure: exactly one H1 title, and a `## Sources` section after at least
// MIN_SECTIONS argument sections.
const h1_count = lines.filter((line) => /^# /.test(line)).length;
if (h1_count !== 1) {
  failures.push(`expected exactly one "# " title, found ${h1_count}`);
}

const h2_titles = lines
  .filter((line) => /^## /.test(line))
  .map((line) => line.slice(3).trim());
const has_sources = h2_titles.some((title) => /^sources$/i.test(title));
if (!has_sources) {
  failures.push('missing a "## Sources" section');
}
const section_count = h2_titles.filter((title) => !/^sources$/i.test(title)).length;
if (section_count < MIN_SECTIONS) {
  failures.push(
    `expected at least ${MIN_SECTIONS} "## " sections besides Sources, found ${section_count}`,
  );
}

// Word count: body prose only — headings and everything under Sources are
// excluded, so a padded source list cannot buy words.
const sources_at = lines.findIndex((line) => /^## sources\s*$/i.test(line.trim()));
const body = lines.filter(
  (line, index) => !/^#{1,6} /.test(line) && (sources_at === -1 || index < sources_at),
);
const words = body.join(' ').split(/\s+/).filter(Boolean).length;
if (words < MIN_WORDS || words > MAX_WORDS) {
  failures.push(`body is ${words} words; expected ${MIN_WORDS}–${MAX_WORDS}`);
}

// Citations-present: list items under `## Sources` (the one place lists belong).
if (sources_at !== -1) {
  const sources = lines
    .slice(sources_at + 1)
    .filter((line) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)).length;
  if (sources < MIN_SOURCES) {
    failures.push(`expected at least ${MIN_SOURCES} sources listed, found ${sources}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.log(`FAIL: ${failure}`);
  process.exit(1);
}
console.log(`ok: essay.md — ${words} words, ${section_count} sections + Sources`);
