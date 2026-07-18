/**
 * Shape helpers over the vector primitives. `midpoint` delegates to vec and
 * needs no change once vec is 3D — but `centroid` seeds its reduce with a point
 * literal of its own, which must gain a z or the sum drops the axis.
 */
import { add, scale } from './vec.mjs';

/** Point halfway between two points. */
export function midpoint(a, b) {
  return scale(add(a, b), 0.5);
}

/** Average of a set of points. */
export function centroid(points) {
  const sum = points.reduce((acc, p) => add(acc, p), { x: 0, y: 0 }); // TODO(3D): seed z: 0
  return scale(sum, 1 / points.length);
}
