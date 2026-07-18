/**
 * Physics helpers. `speed` delegates to vec.magnitude and follows it to 3D for
 * free — but `drag` constructs its own vector literal, which must gain a z.
 */
import { magnitude } from './vec.mjs';

/** Scalar speed = magnitude of the velocity vector. */
export function speed(velocity) {
  return magnitude(velocity);
}

/** Drag force: opposite the velocity, scaled by a coefficient. */
export function drag(velocity, coefficient) {
  return { x: -velocity.x * coefficient, y: -velocity.y * coefficient }; // TODO(3D): thread z
}
