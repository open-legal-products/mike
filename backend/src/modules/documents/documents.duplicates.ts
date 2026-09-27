// Exact-duplicate lookup for uploads: which file hashes (SHA-256 of the raw
// bytes, the value stored as document_versions.content_sha256) already
// exist as the current version of one of the given documents.
//
// Shared by the project and library upload checks. The caller decides which
// documents are in scope (a project's, or a user's library of one kind) and
// authorises the request first; this only compares hashes within that set.
import { fetchAllPages } from "../../lib/pagination";
import type { Db } from "../../lib/supabase";

export type DuplicateDocumentMatch = {
  id: string;
  filename: string;
  folder_id: string | null;
};

export type DuplicateCandidate = {
  id: string;
  current_version_id: string | null;
  /** Project folder or library folder, whichever the scope uses. */
  folder_id: string | null;
};

const SHA256_HEX = /^[0-9a-f]{64}$/;
export const MAX_DUPLICATE_CHECK_HASHES = 100;
// Hashes per `in.(...)` filter: 25 × 64 hex characters keeps the query
// string far below proxy header limits.
const HASH_BATCH = 25;

/**
 * Validate a request's `hashes`: at most 100 lower-case SHA-256 hex strings.
 * Returns them de-duplicated, or null when the value is malformed.
 */
export function parseContentHashes(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > MAX_DUPLICATE_CHECK_HASHES ||
    !value.every((hash) => typeof hash === "string" && SHA256_HEX.test(hash))
  ) {
    return null;
  }
  return [...new Set(value as string[])];
}

/**
 * `{ [hash]: matches }` for the hashes whose bytes are the current version
 * of a candidate document. Older versions and documents outside the
 * candidates (other projects, other users) never match, even when their
 * bytes are identical.
 */
export async function matchDocumentsByContentHash(
  db: Db,
  candidates: DuplicateCandidate[],
  hashes: string[],
): Promise<
  | { ok: true; matches: Record<string, DuplicateDocumentMatch[]> }
  | { ok: false; error: unknown }
> {
  const byCurrentVersion = new Map(
    candidates
      .filter((doc) => doc.current_version_id)
      .map((doc) => [doc.current_version_id as string, doc]),
  );
  const matches: Record<string, DuplicateDocumentMatch[]> = {};
  if (byCurrentVersion.size === 0 || hashes.length === 0) {
    return { ok: true, matches };
  }
  for (let i = 0; i < hashes.length; i += HASH_BATCH) {
    const batch = hashes.slice(i, i + HASH_BATCH);
    // All versions with these hashes, instance-wide (the service role sees
    // every row): paged, so copies elsewhere beyond the row cap cannot crowd
    // out a match in scope. Out-of-scope rows are dropped below.
    const versions = await fetchAllPages<{
      id: string;
      filename: string | null;
      content_sha256: string;
    }>((from, to) =>
      db
        .from("document_versions")
        .select("id, filename, content_sha256")
        .in("content_sha256", batch)
        .is("deleted_at", null)
        .order("id")
        .range(from, to),
    );
    if (!versions.ok) return { ok: false, error: versions.error };
    for (const version of versions.rows) {
      const doc = byCurrentVersion.get(version.id);
      if (!doc) continue;
      (matches[version.content_sha256] ??= []).push({
        id: doc.id,
        filename: version.filename ?? "",
        folder_id: doc.folder_id ?? null,
      });
    }
  }
  return { ok: true, matches };
}
