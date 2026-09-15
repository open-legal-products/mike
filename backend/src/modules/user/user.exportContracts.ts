// exportContracts — implementation behind the module facade.

/** The export types a client may request; anything else is a 400 upstream. */
export const EXPORT_TYPES = [
    "account",
    "chats",
    "tabular-reviews",
    "audit-csv",
    "documents-zip",
    "memory-zip",
] as const;

export type ExportType = (typeof EXPORT_TYPES)[number];

/** The whole-account JSON exports: one artifact per (user, type). */
const JSON_EXPORT_TYPES = ["account", "chats", "tabular-reviews"] as const;

export type JsonExportType = (typeof JSON_EXPORT_TYPES)[number];

/**
 * Upper bound on a documents-zip selection. The zip is assembled in memory,
 * so an unbounded selection is an OOM waiting to happen; the route rejects
 * oversized requests with a 400 and the handler treats one that slipped
 * through as malformed rather than retrying it forever.
 */
export const MAX_ZIP_EXPORT_DOCUMENTS = 500;
