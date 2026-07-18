import test from 'node:test';
import assert from 'node:assert/strict';
import { add, scale, magnitude } from './vec.mjs';
import { centroid } from './shapes.mjs';
import { speed, drag } from './physics.mjs';

test('magnitude is the 3D length', () => {
  assert.equal(magnitude({ x: 2, y: 3, z: 6 }), 7); // hypot(2, 3, 6) === 7
});

test('add sums all three axes', () => {
  assert.deepEqual(add({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }), { x: 5, y: 7, z: 9 });
});

test('scale scales all three axes', () => {
  assert.deepEqual(scale({ x: 1, y: 2, z: 3 }, 2), { x: 2, y: 4, z: 6 });
});

test('centroid carries z through the reduce seed', () => {
  assert.deepEqual(
    centroid([
      { x: 0, y: 0, z: 0 },
      { x: 6, y: 6, z: 6 },
      { x: 3, y: 3, z: 3 },
    ]),
    { x: 3, y: 3, z: 3 },
  );
});

test('speed follows magnitude into 3D', () => {
  assert.equal(speed({ x: 0, y: 0, z: 5 }), 5);
});

test('drag is a 3D vector', () => {
  assert.deepEqual(drag({ x: 1, y: 2, z: 3 }, 2), { x: -2, y: -4, z: -6 });
});
