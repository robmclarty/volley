/** Delete the record at `id`. Needs a guard: `id` must be a non-empty string,
 *  else throw a TypeError. */
export function remove(store, id) {
  return store.delete(id);
}
