/** MUTANT (do not edit): `peek()` mutates — it pops instead of reading the top.
 *  A suite that peeks and then checks the size (or peeks twice) catches this. */
export class Stack {
  #items = [];
  #capacity;

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

  push(value) {
    if (this.#items.length >= this.#capacity) throw new RangeError('stack is full');
    this.#items.push(value);
    return this.size;
  }

  pop() {
    if (this.isEmpty) throw new RangeError('stack is empty');
    return this.#items.pop();
  }

  peek() {
    if (this.isEmpty) throw new RangeError('stack is empty');
    return this.#items.pop(); // BUG: mutates the stack
  }
}
