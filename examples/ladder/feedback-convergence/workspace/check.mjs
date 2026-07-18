#!/usr/bin/env node
/**
 * feedback-convergence check gate: the exacting behavioral spec the vague prompt
 * omits (see ../criteria.md). Dependency-free — imports the builder's
 * `duration.mjs` and asserts canonical formatting, exact error types, and
 * round-trip identity. Each failure line names the criterion the critic will
 * echo back as `unmet_criteria`.
 */
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const failures = [];
const fail = (msg) => failures.push(msg);

const MODULE = resolve('duration.mjs');
if (!existsSync(MODULE)) {
  console.log('FAIL: duration.mjs not found at the workspace root');
  process.exit(1);
}

const mod = await import(pathToFileURL(MODULE).href);
const { parse, format } = mod;

if (typeof parse !== 'function') fail('duration.mjs must export a function `parse`');
if (typeof format !== 'function') fail('duration.mjs must export a function `format`');

/** Assert `fn()` returns `expected`; record a labeled failure otherwise. */
function expect(label, fn, expected) {
  let actual;
  try {
    actual = fn();
  } catch (err) {
    fail(`${label}: threw ${err?.constructor?.name ?? 'Error'} instead of returning ${JSON.stringify(expected)}`);
    return;
  }
  if (actual !== expected) fail(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

/** Assert `fn()` throws an error whose constructor name is `errName`. */
function expect_throws(label, fn, errName) {
  try {
    fn();
  } catch (err) {
    if (err?.constructor?.name !== errName) {
      fail(`${label}: threw ${err?.constructor?.name ?? 'Error'}, expected ${errName}`);
    }
    return;
  }
  fail(`${label}: did not throw (expected ${errName})`);
}

if (typeof parse === 'function') {
  expect("parse('1h')", () => parse('1h'), 3600000);
  expect("parse('90m')", () => parse('90m'), 5400000);
  expect("parse('1h30m')", () => parse('1h30m'), 5400000);
  expect("parse('2h15m30s')", () => parse('2h15m30s'), 8130000);
  expect("parse('500ms')", () => parse('500ms'), 500);
  expect("parse('1d')", () => parse('1d'), 86400000);
  expect("parse('1h 30m') ignores whitespace", () => parse('1h 30m'), 5400000);
  expect_throws("parse('') throws SyntaxError", () => parse(''), 'SyntaxError');
  expect_throws("parse('nonsense') throws SyntaxError", () => parse('nonsense'), 'SyntaxError');
  expect_throws("parse('-1h') throws RangeError", () => parse('-1h'), 'RangeError');
  expect_throws("parse('1.5h') throws RangeError", () => parse('1.5h'), 'RangeError');
}

if (typeof format === 'function') {
  expect('format(5400000)', () => format(5400000), '1h30m');
  expect('format(3600000)', () => format(3600000), '1h');
  expect('format(8130000)', () => format(8130000), '2h15m30s');
  expect('format(500)', () => format(500), '500ms');
  expect('format(0)', () => format(0), '0ms');
  expect_throws('format(-1) throws RangeError', () => format(-1), 'RangeError');
  expect_throws('format(1.5) throws RangeError', () => format(1.5), 'RangeError');
}

if (typeof parse === 'function' && typeof format === 'function') {
  for (const s of ['1h30m', '1h', '2h15m30s', '500ms', '0ms']) {
    expect(`round-trip format(parse('${s}'))`, () => format(parse(s)), s);
  }
}

if (failures.length > 0) {
  for (const f of failures) console.log(`FAIL: ${f}`);
  process.exit(1);
}
console.log('ok: duration.mjs meets the spec');
