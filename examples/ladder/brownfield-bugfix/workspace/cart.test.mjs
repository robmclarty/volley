import test from 'node:test';
import assert from 'node:assert/strict';
import { subtotal, applyDiscount, withShipping } from './cart.mjs';

test('subtotal multiplies price by quantity', () => {
  assert.equal(
    subtotal([
      { price: 10, quantity: 2 },
      { price: 5, quantity: 3 },
    ]),
    35,
  );
});

test('subtotal of an empty cart is 0', () => {
  assert.equal(subtotal([]), 0);
});

test('applyDiscount returns the total left after the discount', () => {
  assert.equal(applyDiscount(200, 10), 180);
  assert.equal(applyDiscount(50, 0), 50);
  assert.equal(applyDiscount(80, 25), 60);
});

test('withShipping is free at or above the threshold', () => {
  assert.equal(withShipping(50), 50); // exactly at the default threshold → free
  assert.equal(withShipping(60), 60); // above → free
  assert.equal(withShipping(40), 45); // below → flat fee
});
