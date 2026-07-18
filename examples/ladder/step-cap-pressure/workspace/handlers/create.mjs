/** Store a record under its `id`. Needs a guard: `record` must be an object
 *  with a non-empty string `id`, else throw a TypeError. */
export function create(store, record) {
  store.set(record.id, record);
  return record;
}
