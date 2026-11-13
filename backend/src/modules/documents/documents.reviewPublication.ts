// A playbook's tracked changes and result have one publication boundary.
// Preparation performs no version writes; only the RPC publishes live state.
import crypto from "node:crypto";
import { can, ensureDocAccess } from "../../lib/access";
import { AppError } from "../../lib/appError";
import { applyTrackedEdits, type EditInput } from "../../lib/docxTrackedChanges";
import { contentSha256 } from "../../lib/documentVersions";
import { deleteFileBestEffort, downloadFile, uploadFile } from "../../lib/storage";
import type { Db } from "../../lib/supabase";
import { profileAttributionName } from "../../lib/userLookup";
import { processDocumentTextInline } from "./documents.indexing";
import { logError } from "../../lib/log";
import { safeError } from "../../lib/safeError";

/**
 * The publication RPC was called and its commit outcome is unknown. Nothing
 * else may use it: callers leave the run `running` for a retry or for the
 * interrupted-work reader. A failure while preparing happens before the RPC
 * and is thrown as itself, so callers can record it as an ordinary failure.
 */
export class DocumentReviewRetryableError extends AppError {
  constructor(cause: unknown) {
    super("playbooks.review_retryable", "Review work could not be recorded", { cause });
  }
}

/** Groups the best-effort delete of a review upload nothing will reference. */
const UNPUBLISHED_UPLOAD = "playbook-review-unpublished";

export type PreparedReviewEdits = {
  documentId: string;
  expectedVersion: { id: string; storagePath: string };
  version: {
    id: string; storage_path: string; source: "assistant_edit";
    filename: string; file_type: "docx"; size_bytes: number;
    page_count: null; content_sha256: string;
  };
  edits: {
    id: string; finding_index: number; change_id: string;
    del_w_id: string | null; ins_w_id: string | null;
    deleted_text: string; inserted_text: string;
    context_before: string; context_after: string; reason?: string;
  }[];
};

/**
 * Access helpers intentionally fail closed on some query errors. A review
 * needs to distinguish that outage from a genuine reader-only document, or
 * it would permanently record a misleading text-only result. Restrict this
 * throwing read view to authorization; keep the same permission ladder and
 * authenticated-email grants, without changing other callers' behavior.
 */
function strictAccessReads(db: Db): Db {
  type ReadBuilder = { throwOnError(): unknown };
  const client = db as unknown as {
    from(table: string): { select(...args: unknown[]): ReadBuilder };
    rpc(...args: unknown[]): ReadBuilder;
  };
  return Object.assign(Object.create(db), {
    from(table: string) {
      const query = client.from(table);
      const select = query.select.bind(query);
      query.select = (...args) => select(...args).throwOnError() as ReadBuilder;
      return query;
    },
    rpc: (...args: unknown[]) => client.rpc(...args).throwOnError(),
  }) as Db;
}

/**
 * Null means a real access/source/matching refusal, never an IO failure. An
 * IO failure throws as itself: nothing has been published yet, so the review
 * can be recorded as failed instead of waiting on an unknown outcome.
 */
export async function prepareDocumentReviewEdits(db: Db, args: {
  documentId: string; userId: string; userEmail?: string | null;
  expectedVersion: { id: string; storagePath: string };
  edits: { findingIndex: number; edit: EditInput }[];
}): Promise<PreparedReviewEdits | null> {
  if (!args.edits.length) return null;
  const { data: doc, error: docError } = await db.from("documents")
    .select("id, user_id, project_id, org_id, workflow_id, current_version_id")
    .eq("id", args.documentId).maybeSingle();
  if (docError) throw docError;
  if (!doc) return null;
  const access = await ensureDocAccess(doc, args.userId, args.userEmail, strictAccessReads(db));
  if (!access.ok || !can(access.projectRole, "content.edit")) return null;
  if (doc.current_version_id !== args.expectedVersion.id) return null;
  const { data: source, error: sourceError } = await db.from("document_versions")
    .select("id, document_id, storage_path, filename")
    .eq("id", args.expectedVersion.id).eq("document_id", args.documentId)
    .is("deleted_at", null).maybeSingle();
  if (sourceError) throw sourceError;
  if (!source || source.storage_path !== args.expectedVersion.storagePath) return null;
  const raw = await downloadFile(source.storage_path);
  if (!raw) throw new Error("Review document bytes unavailable");
  const { data: profile, error: profileError } = await db.from("user_profiles")
    .select("display_name, email").eq("user_id", args.userId).maybeSingle();
  if (profileError) throw profileError;
  const edited = await applyTrackedEdits(Buffer.from(raw), args.edits.map(({ edit }) => edit), {
    author: profileAttributionName(profile, "Mike"),
  });
  if (!edited.changes.length) return null;
  const failed = new Set(edited.errors.map(({ index }) => index));
  const applied = args.edits.filter((_, index) => !failed.has(index));
  if (applied.length !== edited.changes.length)
    throw new AppError("playbooks.edit_mapping_failed", "Review edit mapping failed");
  // Match the existing edit writer's inheritance, including user renames.
  const { data: previous, error: filenameError } = await db.from("document_versions")
    .select("filename, created_at").eq("document_id", args.documentId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (filenameError) throw filenameError;
  const id = crypto.randomUUID();
  const path = `documents/${args.userId}/${args.documentId}/edits/${id.replace(/-/g, "")}.docx`;
  try {
    await uploadFile(path, edited.bytes.buffer.slice(
      edited.bytes.byteOffset, edited.bytes.byteOffset + edited.bytes.byteLength,
    ) as ArrayBuffer, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  } catch (error) {
    // A lost upload response can still leave the object behind. Nothing can
    // reference it: the publication RPC has not been called.
    await deleteFileBestEffort(path, UNPUBLISHED_UPLOAD);
    throw error;
  }
  return {
    documentId: args.documentId, expectedVersion: args.expectedVersion,
    version: {
      id, storage_path: path, source: "assistant_edit", filename: previous?.filename?.trim() || "Untitled document",
      file_type: "docx", size_bytes: edited.bytes.byteLength, page_count: null,
      content_sha256: contentSha256(edited.bytes),
    },
    edits: edited.changes.map((change, index) => ({
      id: crypto.randomUUID(), finding_index: applied[index].findingIndex,
      change_id: change.id, del_w_id: change.delId ?? null, ins_w_id: change.insId ?? null,
      deleted_text: change.deletedText, inserted_text: change.insertedText,
      context_before: change.contextBefore, context_after: change.contextAfter, reason: change.reason,
    })),
  };
}

export type ReviewPublication = {
  disposition: "published" | "source_changed" | "existing" | "missing" | "terminal";
  run?: Record<string, unknown>;
};

/**
 * Deletes a prepared upload that will never be published: the review was
 * stopped before `publishDocumentReview`, so no version can reference it.
 */
export function discardUnpublishedReviewUpload(
  prepared: PreparedReviewEdits,
): Promise<void | undefined> {
  return deleteFileBestEffort(prepared.version.storage_path, UNPUBLISHED_UPLOAD);
}

/**
 * Trusted persistence, not authorization. Findings must be normalized and
 * unlinked. The documents module owns the version/edit RPC; it knows no
 * playbook implementation or schema type.
 *
 * The prepared upload is deleted only when the database's answer proves no
 * version row can ever reference it: any disposition but `published`, or a
 * validation/constraint error, which rolls the whole transaction back. Never
 * clean an upload on an ambiguous response: missing history can coexist with
 * a committed version, and a running reread can precede an RPC that is still
 * in flight. Document deletion only removes objects a version references, so
 * an upload leaked here would keep the contract text after the document.
 */
export async function publishDocumentReview(db: Db, args: {
  runId: string; userId: string; summary: string;
  findings: readonly Record<string, unknown>[];
  prepared: PreparedReviewEdits | null;
}): Promise<ReviewPublication> {
  const prepared = args.prepared;
  const discardUpload = async () => {
    if (prepared) await discardUnpublishedReviewUpload(prepared);
  };
  let result: ReviewPublication;
  let reconciled = false;
  try {
    const { data, error } = await db.rpc("publish_playbook_review", {
      p_run_id: args.runId, p_user_id: args.userId,
      p_summary: args.summary, p_findings: args.findings,
      p_document_id: prepared?.documentId ?? null,
      p_expected_version_id: prepared?.expectedVersion.id ?? null,
      p_expected_storage_path: prepared?.expectedVersion.storagePath ?? null,
      p_version: prepared?.version ?? null, p_edits: prepared?.edits ?? [],
    });
    if (error) throw error;
    if (!data) throw new Error("Review publication returned no result");
    result = data as ReviewPublication;
  } catch (error) {
    // An explicit validation/constraint SQL error proves rollback and is not
    // an uncertain transport outcome. Do not rerun the model for bad input.
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string" && (/^(22|23)/.test(code) || code === "P0002")) {
      await discardUpload();
      throw error;
    }
    let run: Record<string, unknown> | null = null;
    try {
      const read = await db.from("playbook_runs")
        .select("*").eq("id", args.runId).eq("user_id", args.userId).maybeSingle();
      if (!read.error) run = read.data;
    } catch { /* Preserve the original publication fault and unknown outcome. */ }
    if (run?.status !== "completed") throw new DocumentReviewRetryableError(error);
    // Reconciled, not answered: this call's own commit may be what completed
    // the run, so its upload is kept.
    reconciled = true;
    result = { disposition: "existing", run };
  }
  // Answered by the RPC: `existing` and `source_changed` completed the run
  // without this upload, and `missing`/`terminal` wrote nothing.
  if (!reconciled && result.disposition !== "published") await discardUpload();
  if (result.run?.status === "completed" && typeof result.run.edited_version_id === "string") {
    // The SQL transaction queues extraction. Inline installations still need
    // to perform it, but an indexing fault cannot undo a saved review.
    await processDocumentTextInline(db, [result.run.edited_version_id])
      .catch((error) => logError("document-text", safeError(error)));
  }
  return result;
}
