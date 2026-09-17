/**
 * Read-only workspace tools for non-CLI critics.
 *
 * The implementation lives in the shared `src/workspace_tools.ts` module so
 * the builder tool set can reuse `contain()` and the read tools without
 * reaching into this one (`no-deep-sibling-import`). A non-CLI critic
 * still has no write path and cannot escape the workspace.
 */
export {
  IGNORED_DIRS,
  LIST_MAX_ENTRIES,
  READ_FILE_MAX_BYTES,
  SEARCH_MAX_MATCHES,
  contain,
  read_only_tools,
  workspace_inventory,
} from '../workspace_tools.js';
