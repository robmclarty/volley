/**
 * 2D vector primitives. Everything downstream (shapes.mjs, physics.mjs) builds
 * on these. The migration to 3D starts here — but does not end here.
 */

/** Component-wise sum. */
export function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y }; // TODO(3D): thread z
}

/** Scale a vector by a scalar. */
export function scale(v, k) {
  return { x: v.x * k, y: v.y * k }; // TODO(3D): thread z
}

/** Euclidean length. */
export function magnitude(v) {
  return Math.hypot(v.x, v.y); // TODO(3D): include z
}
