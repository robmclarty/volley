/** MUTANT (do not edit): popping/peeking an empty stack returns undefined
 *  instead of throwing. A suite that asserts pop()/peek() throw on empty catches
 *  this. */
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
    return this.#items.pop(); // BUG: no empty guard — returns undefined
  }

  peek() {
    return this.#items[this.#items.length - 1]; // BUG: no empty guard — returns undefined
  }
}
