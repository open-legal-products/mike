/**
 * The pane's small key/value store for preferences and cleanup.
 *
 * `OfficeRuntime.storage` is the documented place for add-in data, but the
 * `OfficeRuntime` global only exists where Office injected it. Naming it
 * anywhere else (taskpane.html opened in a plain browser tab, or a Word host
 * without the SharedRuntime storage API) throws a ReferenceError before any
 * promise exists, so a caller's `.catch()` never sees it. Every method here
 * is `async`, which turns that synchronous throw, or one from a blocked
 * `localStorage`, into a rejected promise the caller already handles.
 *
 * Without `OfficeRuntime.storage` the pane falls back to `localStorage`,
 * which Microsoft documents as the alternative for task panes. Office-free on
 * purpose (no `OfficeRuntime` type is named), so the web app's test program
 * can typecheck it.
 */
export interface PaneStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

function backingStore(): PaneStorage | Storage {
  const office = (globalThis as { OfficeRuntime?: { storage?: PaneStorage } })
    .OfficeRuntime?.storage;
  return office ?? globalThis.localStorage;
}

export const paneStorage: PaneStorage = {
  async getItem(key) {
    return backingStore().getItem(key);
  },
  async setItem(key, value) {
    await backingStore().setItem(key, value);
  },
  async removeItem(key) {
    await backingStore().removeItem(key);
  },
};
