/**
 * A tiny shopping-cart pricing module. Three functions, three planted bugs —
 * the accompanying `cart.test.mjs` documents the intended behavior and fails
 * until they are fixed. Fix the function bodies here; do not touch the tests.
 */

/** Sum of line totals: `price * quantity` for each item. */
export function subtotal(items) {
  let sum = 0;
  for (const item of items) {
    sum += item.price; // BUG: ignores item.quantity
  }
  return sum;
}

/** Apply a percentage discount. `pct` is 0–100; returns the discounted total. */
export function applyDiscount(total, pct) {
  return total * (pct / 100); // BUG: returns the discount, not the remaining total
}

/** Free shipping at or above `threshold`, otherwise a flat `fee`. */
export function withShipping(total, { threshold = 50, fee = 5 } = {}) {
  return total > threshold ? total : total + fee; // BUG: at exactly threshold should be free
}
