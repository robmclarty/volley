/** MUTANT (do not edit): the capacity guard is off by one — it allows one item
 *  past `capacity`. A suite that fills a bounded stack and expects the next push
 *  to throw catches this. */
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
    if (this.#items.length > this.#capacity) throw new RangeError('stack is full'); // BUG: > not >=
    this.#items.push(value);
    return this.size;
  }

  pop() {
    if (this.isEmpty) throw new RangeError('stack is empty');
    return this.#items.pop();
  }

  peek() {
    if (this.isEmpty) throw new RangeError('stack is empty');
    return this.#items[this.#items.length - 1];
  }
}
