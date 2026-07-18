/** Fetch a record by `id`. Needs a guard: `id` must be a non-empty string,
 *  else throw a TypeError. */
export function read(store, id) {
  return store.get(id);
}
