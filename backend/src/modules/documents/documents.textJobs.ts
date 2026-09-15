// documentJobs — implementation behind the module facade.
import { downloadFile, extractedTextKey, uploadFile } from "../../lib/storage";
import { requiresLibreOfficeTextExtraction } from "../../lib/documentTypes";
import { extractLegacyOfficeText } from "../../lib/pdfText";
import { type Db, type DbJob } from "../../lib/dbq/types";
import { enqueueDbJob } from "../../lib/dbq/enqueue";

/**
 * Precompute a legacy Office version's plain text into the read_document
 * cache.
 *
 * WHY: .doc and .ppt have no in-process reader, so read_document shells out
 * to LibreOffice on EVERY call — inside the chat tool call the user is
 * waiting on. Doing it once here, off the request path, turns that into a
 * single storage GET.
 *
 * Idempotent: the key is derived from the immutable version id, so a retry
 * overwrites its own object with identical bytes.
 */
export async function handleDocumentPrecomputeText(
  db: Db,
  job: DbJob,
): Promise<void> {
  const versionId = job.payload.versionId as string | undefined;
  const storagePath = job.payload.storagePath as string | undefined;
  const fileType = job.payload.fileType as string | undefined;
  // Gate on the file type as well as the ids: this handler is the only
  // thing that would run LibreOffice off a queue payload, and a job for a
  // type that already has an in-process reader is a mistake, not work.
  if (
    !versionId ||
    !storagePath ||
    !requiresLibreOfficeTextExtraction(fileType)
  ) {
    return;
  }

  const isCurrent = async () => {
    const { data, error } = await db
      .from("document_versions")
      .select("id")
      .eq("id", versionId)
      .eq("storage_path", storagePath)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) throw error;
    return !!data;
  };
  const retireCache = () =>
    enqueueDbJob(db, {
      kind: "document.cleanup",
      payload: { versionId, keys: [extractedTextKey(versionId)] },
    });
  if (!(await isCurrent())) {
    await retireCache();
    return;
  }

  const raw = await downloadFile(storagePath);
  if (!raw) {
    // Storage may simply be lagging; a genuinely deleted source runs the
    // attempt budget out and then stops, which is the right end state.
    throw new Error(
      `[document.precompute_text] source unavailable: ${storagePath}`,
    );
  }
  const text = await extractLegacyOfficeText(raw);
  const body = Buffer.from(text, "utf8");
  await uploadFile(
    extractedTextKey(versionId),
    body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    ) as ArrayBuffer,
    "text/plain; charset=utf-8",
  );
  // Replacement/deletion during conversion invalidates the just-written
  // cache. The cleanup handler waits for this running claim to finish.
  if (!(await isCurrent())) await retireCache();
}
