/**
 * Whether volley is running inside its sandbox container. A leaf, so the
 * config resolution, the preflight, and the run-config signing can all ask
 * without importing one another.
 */

/** volley *detects* it is running inside its sandbox container rather than
 * starting the container itself. The signal is the `VOLLEY_CONTAINED=1` marker
 * volley's own image bakes in (`Dockerfile` `ENV`), so a `docker run <hardened
 * flags> <image> volley run …` is recognized as contained out of the box. Kept
 * env-only — no ambient `/.dockerenv` probe — so the safety gate is deterministic
 * and testable, and so a CI job that itself runs in an unrelated container does
 * not silently satisfy the gate; a hand-rolled sandbox must set the marker (or
 * the operator uses `--allow-unsandboxed-builder`). */
export function detect_containment(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env['VOLLEY_CONTAINED'];
  return value === '1' || value === 'true';
}
