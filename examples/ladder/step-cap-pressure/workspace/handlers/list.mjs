/** List records, optionally capped at `limit`. Needs a guard: if `limit` is
 *  passed it must be a non-negative integer, else throw a TypeError. (Without
 *  the guard `slice` silently coerces a bad limit to 0 and hides the error.) */
export function list(store, limit) {
  const records = [...store.values()];
  return limit === undefined ? records : records.slice(0, limit);
}
