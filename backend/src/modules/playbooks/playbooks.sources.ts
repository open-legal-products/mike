// Supplementary documents: copies a playbook owns so its rules can refer to
// them. Viewing follows the playbook's view access; adding and removing follow
// its edit access. Reviews list them and read one on request (see the review
// tool in playbooks.operations.ts).

import crypto from "node:crypto";
import { safeError } from "../../lib/safeError";
import { createServerSupabase, type Db } from "../../lib/supabase";
import { deleteFile, downloadFile, headFile, uploadFile } from "../../lib/storage";
import { extractDocxBodyText } from "../../lib/docxTrackedChanges";
import { extractPdfTextForModel } from "../../lib/pdfText";
import { getFileStreamSource } from "../documents/documents.service";
import {
  editablePlaybook,
  getPlaybook,
  PlaybookRequestError,
  type Playbook,
} from "./playbooks.operations";
import {
  listPlaybookSourceRows,
  type PlaybookSourceFileType,
  type PlaybookSourceRow,
} from "./playbooks.sourceStore";
import { isStagedPlaybookSourceKey } from "./playbooks.staging";

export const MAX_PLAYBOOK_SOURCES = 20;
export const MAX_PLAYBOOK_SOURCE_FILE_BYTES = 25 * 1024 * 1024;
/** Enough for a long policy; anything beyond is not read by a review. */
const MAX_STORED_TEXT_CHARS = 2_000_000;

export const PLAYBOOK_SOURCE_CONTENT_TYPES: Record<
  PlaybookSourceFileType,
  string
> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

export type PublicPlaybookSource = {
  id: string;
  filename: string;
  fileType: PlaybookSourceFileType;
  sizeBytes: number;
  createdAt: string;
};

export function playbookSourceFileType(
  value: string | null | undefined,
): PlaybookSourceFileType | null {
  const raw = (value ?? "").trim().toLowerCase();
  const ext = raw.includes(".") ? raw.split(".").pop() : raw;
  return ext === "docx" || ext === "pdf" ? ext : null;
}

function publicSource(row: PlaybookSourceRow): PublicPlaybookSource {
  return {
    id: row.id,
    filename: row.filename,
    fileType: row.fileType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
  };
}

function sizeError(): PlaybookRequestError {
  return new PlaybookRequestError(
    `Supplementary documents must be ${Math.floor(
      MAX_PLAYBOOK_SOURCE_FILE_BYTES / (1024 * 1024),
    )} MB or smaller.`,
  );
}

export async function listPlaybookSources(
  userId: string,
  playbookId: string,
  db: Db = createServerSupabase(),
  email?: string | null,
): Promise<PublicPlaybookSource[]> {
  await getPlaybook(userId, playbookId, db, email);
  return (await listPlaybookSourceRows(db, playbookId)).map(publicSource);
}

export async function getPlaybookSourceFile(
  userId: string,
  playbookId: string,
  sourceId: string,
  db: Db = createServerSupabase(),
  email?: string | null,
): Promise<{ storageKey: string; filename: string; contentType: string } | null> {
  await getPlaybook(userId, playbookId, db, email);
  const row = (await listPlaybookSourceRows(db, playbookId)).find(
    (entry) => entry.id === sourceId,
  );
  if (!row) return null;
  return {
    storageKey: row.storageKey,
    filename: row.filename,
    contentType: PLAYBOOK_SOURCE_CONTENT_TYPES[row.fileType],
  };
}

async function extractSourceText(
  fileType: PlaybookSourceFileType,
  bytes: ArrayBuffer,
): Promise<string> {
  let text: string;
  try {
    text =
      fileType === "pdf"
        ? await extractPdfTextForModel(bytes)
        : await extractDocxBodyText(Buffer.from(bytes));
  } catch (cause) {
    throw new PlaybookRequestError(
      "The document could not be read. Check that it is a valid .docx or .pdf file.",
      400,
      { cause },
    );
  }
  // Postgres text cannot hold NUL, which some PDFs carry.
  return text.replace(/\u0000/g, "").slice(0, MAX_STORED_TEXT_CHARS);
}

async function storeSource(
  db: Db,
  playbook: Playbook,
  userId: string,
  file: { filename: string; fileType: PlaybookSourceFileType; bytes: ArrayBuffer },
): Promise<PublicPlaybookSource> {
  const existing = await listPlaybookSourceRows(db, playbook.id);
  if (existing.length >= MAX_PLAYBOOK_SOURCES)
    throw new PlaybookRequestError(
      `A playbook can keep up to ${MAX_PLAYBOOK_SOURCES} supplementary documents.`,
      409,
    );
  const text = await extractSourceText(file.fileType, file.bytes);
  const id = crypto.randomUUID();
  const storageKey = `playbooks/${playbook.userId}/${playbook.id}/sources/${id}.${file.fileType}`;
  await uploadFile(
    storageKey,
    file.bytes,
    PLAYBOOK_SOURCE_CONTENT_TYPES[file.fileType],
  );
  const createdAt = new Date().toISOString();
  const filename = file.filename.trim().slice(0, 255) || `document.${file.fileType}`;
  const { error } = await db.from("playbook_sources").insert({
    id,
    playbook_id: playbook.id,
    filename,
    file_type: file.fileType,
    storage_key: storageKey,
    size_bytes: file.bytes.byteLength,
    extracted_text: text,
    text_length: text.length,
    created_by: userId,
    created_at: createdAt,
  });
  if (error) {
    await deleteFile(storageKey).catch(() => {});
    throw error;
  }
  return {
    id,
    filename,
    fileType: file.fileType,
    sizeBytes: file.bytes.byteLength,
    createdAt,
  };
}

/**
 * Copy a file the editor staged with a presigned upload. The caller deletes
 * the staged object afterwards, whatever the outcome.
 */
export async function addPlaybookSourceFromUpload(
  userId: string,
  userEmail: string | undefined,
  playbookId: string,
  upload: { storageKey: string; filename: string },
  db: Db = createServerSupabase(),
): Promise<PublicPlaybookSource> {
  const playbook = await editablePlaybook(userId, playbookId, db, userEmail);
  // Only a key minted for this caller; see playbooks.staging.ts.
  if (!isStagedPlaybookSourceKey(userId, upload.storageKey))
    throw new PlaybookRequestError("Upload the document before adding it.");
  const fileType = playbookSourceFileType(upload.filename);
  if (!fileType) throw new PlaybookRequestError("Add a .docx or .pdf file.");
  const stat = await headFile(upload.storageKey);
  if (!stat)
    throw new PlaybookRequestError("The uploaded document is no longer available.");
  if (stat.size > MAX_PLAYBOOK_SOURCE_FILE_BYTES) throw sizeError();
  const bytes = await downloadFile(upload.storageKey);
  if (!bytes)
    throw new PlaybookRequestError("The uploaded document could not be read.");
  return storeSource(db, playbook, userId, {
    filename: upload.filename,
    fileType,
    bytes,
  });
}

/** Copy a document the editor can open from their library or a project. */
export async function addPlaybookSourceFromDocument(
  userId: string,
  userEmail: string | undefined,
  playbookId: string,
  documentId: string,
  db: Db = createServerSupabase(),
): Promise<PublicPlaybookSource> {
  const playbook = await editablePlaybook(userId, playbookId, db, userEmail);
  const source = await getFileStreamSource(
    documentId,
    userId,
    userEmail,
    null,
    db,
  );
  if (!source.ok) throw new PlaybookRequestError("Document not found.", 404);
  const fileType =
    playbookSourceFileType(source.fileType) ??
    playbookSourceFileType(source.filename);
  if (!fileType) throw new PlaybookRequestError("Add a .docx or .pdf file.");
  if (source.size > MAX_PLAYBOOK_SOURCE_FILE_BYTES) throw sizeError();
  const bytes = await downloadFile(source.storagePath);
  if (!bytes) throw new PlaybookRequestError("The document could not be read.");
  return storeSource(db, playbook, userId, {
    filename: source.filename,
    fileType,
    bytes,
  });
}

export async function deletePlaybookSource(
  userId: string,
  userEmail: string | undefined,
  playbookId: string,
  sourceId: string,
  db: Db = createServerSupabase(),
): Promise<void> {
  await editablePlaybook(userId, playbookId, db, userEmail);
  const { data, error } = await db
    .from("playbook_sources")
    .delete()
    .eq("playbook_id", playbookId)
    .eq("id", sourceId)
    .select("storage_key")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new PlaybookRequestError("Source document not found.", 404);
  await deleteFile(String(data.storage_key)).catch((cause) => {
    console.error("[playbooks] source file cleanup failed", {
      sourceId,
      error: safeError(cause),
    });
  });
}
