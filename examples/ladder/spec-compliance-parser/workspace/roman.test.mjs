import test from 'node:test';
import assert from 'node:assert/strict';
import { toRoman, fromRoman } from './roman.mjs';

const CANONICAL = [
  [1, 'I'],
  [4, 'IV'],
  [9, 'IX'],
  [40, 'XL'],
  [58, 'LVIII'],
  [90, 'XC'],
  [400, 'CD'],
  [900, 'CM'],
  [1994, 'MCMXCIV'],
  [2024, 'MMXXIV'],
  [3999, 'MMMCMXCIX'],
];

test('toRoman renders canonical numerals', () => {
  for (const [n, s] of CANONICAL) assert.equal(toRoman(n), s);
});

test('toRoman rejects out-of-range and non-integer input', () => {
  assert.throws(() => toRoman(0), RangeError);
  assert.throws(() => toRoman(-1), RangeError);
  assert.throws(() => toRoman(4000), RangeError);
  assert.throws(() => toRoman(3.5), RangeError);
});

test('fromRoman parses well-formed numerals', () => {
  for (const [n, s] of CANONICAL) assert.equal(fromRoman(s), n);
});

test('fromRoman rejects malformed numerals', () => {
  for (const bad of ['IIII', 'VV', 'MMMM', 'IL', 'IC', 'XM', 'VX', '', 'iv', 'ABC']) {
    assert.throws(() => fromRoman(bad), SyntaxError, `expected ${JSON.stringify(bad)} to throw`);
  }
});

test('round-trips across the range', () => {
  for (const n of [1, 4, 9, 14, 49, 99, 444, 888, 1666, 2222, 3888, 3999]) {
    assert.equal(fromRoman(toRoman(n)), n);
  }
});
