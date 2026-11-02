// Row access for a playbook's supplementary documents, without access checks.
// Callers authorize first: playbooks.sources.ts for the HTTP surface, and the
// review and delete paths in playbooks.operations.ts, which this file must not
// import so the two stay free of a cycle.

import type { Db } from "../../lib/supabase";

export type PlaybookSourceFileType = "docx" | "pdf";

export type PlaybookSourceRow = {
  id: string;
  filename: string;
  fileType: PlaybookSourceFileType;
  sizeBytes: number;
  storageKey: string;
  /** Length of the stored text, so a review can list it without loading it. */
  textLength: number;
  createdAt: string;
};

/** A review reads a long document in pieces of at most this many characters. */
export const SOURCE_TEXT_PAGE_CHARS = 40_000;

export async function listPlaybookSourceRows(
  db: Db,
  playbookId: string,
): Promise<PlaybookSourceRow[]> {
  const { data, error } = await db
    .from("playbook_sources")
    .select(
      "id, filename, file_type, size_bytes, storage_key, text_length, created_at",
    )
    .eq("playbook_id", playbookId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: String(row.id),
    filename: String(row.filename),
    fileType: row.file_type === "pdf" ? "pdf" : "docx",
    sizeBytes: Number(row.size_bytes),
    storageKey: String(row.storage_key),
    textLength: Number(row.text_length ?? 0),
    createdAt: String(row.created_at),
  }));
}

/**
 * One page of a supplementary document's text, as the review tool returns it
 * to the model. Null when the playbook has no such document.
 */
export async function readPlaybookSourceText(
  db: Db,
  playbookId: string,
  sourceId: string,
  offset = 0,
): Promise<{
  filename: string;
  text: string;
  start: number;
  total: number;
  next: number | null;
} | null> {
  const { data, error } = await db
    .from("playbook_sources")
    .select("filename, extracted_text")
    .eq("playbook_id", playbookId)
    .eq("id", sourceId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const full = String(data.extracted_text ?? "");
  const start = Math.min(Math.max(0, Math.floor(offset)), full.length);
  const end = Math.min(full.length, start + SOURCE_TEXT_PAGE_CHARS);
  return {
    filename: String(data.filename),
    text: full.slice(start, end),
    start,
    total: full.length,
    next: end < full.length ? end : null,
  };
}
