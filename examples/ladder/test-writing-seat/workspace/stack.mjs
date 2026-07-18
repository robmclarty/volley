/**
 * A bounded LIFO stack. This module is correct and is the subject under test —
 * do not change it. Write `stack.test.mjs` to pin every behavior below; the
 * planted mutants in `mutants/` exist to prove your suite is not vacuous.
 */
export class Stack {
  #items = [];
  #capacity;

  /** @param {number} capacity - max items; must be > 0 (defaults to unbounded). */
  constructor(capacity = Infinity) {
    if (!(capacity > 0)) throw new RangeError('capacity must be a positive number');
    this.#capacity = capacity;
  }

  get size() {
    return this.#items.length;
  }

  get isEmpty() {
    return this.#items.length === 0;
  }

  /** Push a value; throws RangeError if the stack is at capacity. Returns the new size. */
  push(value) {
    if (this.#items.length >= this.#capacity) throw new RangeError('stack is full');
    this.#items.push(value);
    return this.size;
  }

  /** Remove and return the top; throws RangeError if empty. */
  pop() {
    if (this.isEmpty) throw new RangeError('stack is empty');
    return this.#items.pop();
  }

  /** Return the top without removing it; throws RangeError if empty. */
  peek() {
    if (this.isEmpty) throw new RangeError('stack is empty');
    return this.#items[this.#items.length - 1];
  }
}
