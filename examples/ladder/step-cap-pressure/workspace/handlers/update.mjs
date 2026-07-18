/** Merge `patch` into the record at `id`. Needs a guard: `id` must be a
 *  non-empty string and `patch` must be an object, else throw a TypeError. */
export function update(store, id, patch) {
  const next = { ...store.get(id), ...patch };
  store.set(id, next);
  return next;
}
