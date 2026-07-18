import test from 'node:test';
import assert from 'node:assert/strict';
import { create } from './handlers/create.mjs';
import { read } from './handlers/read.mjs';
import { update } from './handlers/update.mjs';
import { remove } from './handlers/remove.mjs';
import { list } from './handlers/list.mjs';

const seeded = () => new Map([['a', { id: 'a', n: 1 }]]);

test('create validates the record', () => {
  assert.throws(() => create(new Map(), {}), TypeError); // missing id
  assert.throws(() => create(new Map(), { id: '' }), TypeError); // empty id
  const store = new Map();
  assert.deepEqual(create(store, { id: 'x', n: 9 }), { id: 'x', n: 9 });
  assert.equal(store.get('x').n, 9);
});

test('read validates the id', () => {
  assert.throws(() => read(seeded(), 123), TypeError);
  assert.deepEqual(read(seeded(), 'a'), { id: 'a', n: 1 });
});

test('update validates the id and the patch', () => {
  assert.throws(() => update(seeded(), 123, { n: 2 }), TypeError);
  assert.throws(() => update(seeded(), 'a', 'nope'), TypeError);
  assert.deepEqual(update(seeded(), 'a', { n: 2 }), { id: 'a', n: 2 });
});

test('remove validates the id', () => {
  assert.throws(() => remove(seeded(), null), TypeError);
  assert.equal(remove(seeded(), 'a'), true);
});

test('list validates the limit', () => {
  assert.throws(() => list(seeded(), 'two'), TypeError);
  assert.throws(() => list(seeded(), -1), TypeError);
  assert.equal(list(seeded()).length, 1);
  assert.equal(list(new Map([['a', {}], ['b', {}]]), 1).length, 1);
});
