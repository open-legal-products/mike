// AI revisions as real tracked changes in the contract DOCX (Phase 5 slice 4).
//
// The untouched upload stays at reviews.contract_docx_path. Projection writes a
// working copy to contracts/<reviewId>/redline.docx (reviews.contract_redline_path)
// with one w:del/w:ins pair per revision, recorded in review_revision_edits.
// Accept / reject / edit rewrite that working copy in place via Mike's OOXML
// library and ALSO write the Janus review_feedback row, so the moat and the
// negotiation memo see the same decision the document shows.
//
// Anchoring: `find` = original_text (falls back to highlight_text), with
// context taken from contract_text around the first occurrence. The library
// retries with less context and finally find-only; unresolvable revisions get
// an `error` row and stay card-only.

import type { Db } from "../../lib/supabase";
import { downloadFile, storageEnabled, uploadFile } from "../../lib/storage";
import { applyTrackedEdits, resolveTrackedChange, type EditInput } from "../../lib/docxTrackedChanges";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { DOCX_MIME } from "./contracts.files";
import { createFeedback, type FeedbackInput } from "./contracts.feedback";
import type { ReviewFeedbackRow, ReviewOutput, Revision } from "./contracts.types";

export const AI_AUTHOR = "Tinjau (AI Suggestion)";
export function cooAuthor(email: string | undefined): string {
  const local = (email ?? "").split("@")[0] || "COO";
  return `${local} (Tinjau COO Review)`;
}

export function redlineDocxKey(reviewId: string): string {
  return `contracts/${reviewId}/redline.docx`;
}

export interface RevisionEditRow {
  id: string;
  review_id: string;
  revision_id: string;
  change_id: string | null;
  del_w_id: string | null;
  ins_w_id: string | null;
  deleted_text: string | null;
  inserted_text: string | null;
  author: string | null;
  status: "pending" | "accepted" | "rejected";
  error: string | null;
  created_at: string;
  updated_at: string;
}

const CONTEXT_CHARS = 60;

/** Build the library's EditInput for a revision, with context sliced from the contract text. */
export function revisionToEdit(rev: Revision, contractText: string): EditInput {
  const find = (rev.original_text || rev.highlight_text || "").trim();
  const idx = find ? contractText.indexOf(find) : -1;
  const context_before = idx > 0 ? contractText.slice(Math.max(0, idx - CONTEXT_CHARS), idx) : "";
  const context_after = idx >= 0 ? contractText.slice(idx + find.length, idx + find.length + CONTEXT_CHARS) : "";
  return { find, replace: rev.suggested_text ?? "", context_before, context_after, reason: rev.rationale };
}

async function loadBytes(key: string): Promise<Buffer | null> {
  const data = await downloadFile(key);
  return data ? Buffer.from(data) : null;
}

async function storeBytes(key: string, bytes: Buffer): Promise<void> {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  await uploadFile(key, ab, DOCX_MIME);
}

export async function listRevisionEdits(db: Db, reviewId: string): Promise<ServiceResult<RevisionEditRow[]>> {
  const { data, error } = await db
    .from("review_revision_edits")
    .select("*")
    .eq("review_id", reviewId)
    .order("created_at", { ascending: true });
  if (error) return internalFailure(error);
  return ok((data ?? []) as unknown as RevisionEditRow[]);
}

type ReviewForRedline = {
  id: string;
  contract_docx_path: string | null;
  contract_redline_path: string | null;
  contract_text: string | null;
  ai_output: ReviewOutput | null;
};

async function loadReview(db: Db, reviewId: string): Promise<ServiceResult<ReviewForRedline>> {
  const { data, error } = await db
    .from("reviews")
    .select("id, contract_docx_path, contract_redline_path, contract_text, ai_output")
    .eq("id", reviewId)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!data) return failure("not_found", "Tinjauan tidak ditemukan.");
  return ok(data as unknown as ReviewForRedline);
}

export interface ProjectionSummary {
  projected: number;
  failed: number;
  skipped: number;
  edits: RevisionEditRow[];
}

/**
 * Idempotent: revisions that already have a row are skipped. Works on the
 * current working copy (or the original on first run) so re-running after new
 * revisions appear does not disturb resolved changes.
 */
export async function projectRevisions(db: Db, args: { reviewId: string }): Promise<ServiceResult<ProjectionSummary>> {
  if (!storageEnabled) return failure("unavailable", "Penyimpanan dokumen belum dikonfigurasi.");
  const reviewR = await loadReview(db, args.reviewId);
  if (!reviewR.ok) return reviewR;
  const review = reviewR.data;
  if (!review.contract_docx_path) return failure("validation", "Kontrak asli DOCX tidak ditemukan.");
  const revisions = review.ai_output?.revisions ?? [];

  const existingR = await listRevisionEdits(db, review.id);
  if (!existingR.ok) return existingR;
  const done = new Set(existingR.data.map((e) => e.revision_id));
  const pending = revisions.filter((r) => r.id && !done.has(r.id));
  if (pending.length === 0) return ok({ projected: 0, failed: 0, skipped: revisions.length, edits: existingR.data });

  const sourceKey = review.contract_redline_path ?? review.contract_docx_path;
  const bytes = await loadBytes(sourceKey);
  if (!bytes) return failure("not_found", "Berkas kontrak tidak dapat dibaca dari penyimpanan.");

  const edits = pending.map((rev) => revisionToEdit(rev, review.contract_text ?? ""));
  let result;
  try {
    result = await applyTrackedEdits(bytes, edits, { author: AI_AUTHOR });
  } catch (e) {
    return internalFailure(e);
  }

  const errorByIndex = new Map(result.errors.map((e) => [e.index, e.reason]));
  const changes = [...result.changes];
  const rows = pending.map((rev, i) => {
    const err = errorByIndex.get(i);
    if (err !== undefined) {
      return { review_id: review.id, revision_id: rev.id, status: "pending", error: err, author: AI_AUTHOR };
    }
    const change = changes.shift();
    return {
      review_id: review.id,
      revision_id: rev.id,
      change_id: change?.id ?? null,
      del_w_id: change?.delId ?? null,
      ins_w_id: change?.insId ?? null,
      deleted_text: change?.deletedText ?? null,
      inserted_text: change?.insertedText ?? null,
      author: AI_AUTHOR,
      status: "pending",
      error: change ? null : "Perubahan tidak dikembalikan oleh mesin redline.",
    };
  });

  const projected = rows.filter((r) => !r.error).length;
  if (projected > 0) {
    try {
      await storeBytes(redlineDocxKey(review.id), result.bytes);
    } catch (e) {
      return internalFailure(e);
    }
    const { error: uErr } = await db
      .from("reviews")
      .update({ contract_redline_path: redlineDocxKey(review.id) })
      .eq("id", review.id);
    if (uErr) return internalFailure(uErr);
  }

  const { data: inserted, error: iErr } = await db.from("review_revision_edits").insert(rows).select("*");
  if (iErr) return internalFailure(iErr);

  return ok({
    projected,
    failed: rows.length - projected,
    skipped: revisions.length - pending.length,
    edits: [...existingR.data, ...((inserted ?? []) as unknown as RevisionEditRow[])],
  });
}

async function loadEdit(db: Db, reviewId: string, revisionId: string): Promise<ServiceResult<RevisionEditRow>> {
  const { data, error } = await db
    .from("review_revision_edits")
    .select("*")
    .eq("review_id", reviewId)
    .eq("revision_id", revisionId)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!data) return failure("not_found", "Revisi belum dipetakan ke dokumen.");
  return ok(data as unknown as RevisionEditRow);
}

export interface ResolveResult {
  edit: RevisionEditRow;
  feedback: ReviewFeedbackRow;
}

/**
 * Terima / Tolak: resolve the w:del/w:ins pair in the working copy and record
 * the Janus feedback row. Idempotent on an already-resolved edit.
 */
export async function resolveRevision(
  db: Db,
  args: { reviewId: string; revisionId: string; mode: "accept" | "reject"; userId: string; rationale?: string | null },
): Promise<ServiceResult<ResolveResult>> {
  const editR = await loadEdit(db, args.reviewId, args.revisionId);
  if (!editR.ok) return editR;
  const edit = editR.data;
  if (edit.error || !edit.change_id) return failure("conflict", "Revisi ini tidak terpetakan ke dokumen; gunakan umpan balik biasa.");

  const reviewR = await loadReview(db, args.reviewId);
  if (!reviewR.ok) return reviewR;
  const rev = reviewR.data.ai_output?.revisions.find((r) => r.id === args.revisionId);

  if (edit.status === "pending") {
    const key = reviewR.data.contract_redline_path ?? redlineDocxKey(args.reviewId);
    const bytes = await loadBytes(key);
    if (!bytes) return failure("not_found", "Berkas redline tidak dapat dibaca dari penyimpanan.");
    const ids = [edit.del_w_id, edit.ins_w_id].filter((v): v is string => Boolean(v));
    let resolved;
    try {
      resolved = await resolveTrackedChange(bytes, ids, args.mode);
      if (resolved.found) await storeBytes(key, resolved.bytes);
    } catch (e) {
      return internalFailure(e);
    }
  }

  const status = args.mode === "accept" ? "accepted" : "rejected";
  const { data: updated, error: uErr } = await db
    .from("review_revision_edits")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", edit.id)
    .select("*")
    .single();
  if (uErr || !updated) return internalFailure(uErr ?? new Error("Gagal memperbarui status revisi."));

  const feedbackInput: FeedbackInput = {
    finding_type: "revision",
    finding_id: args.revisionId,
    action: args.mode,
    original_text: rev?.suggested_text ?? edit.inserted_text ?? null,
    rationale: args.rationale ?? null,
  };
  const fb = await createFeedback(db, { reviewId: args.reviewId, userId: args.userId, input: feedbackInput });
  if (!fb.ok) return fb;
  return ok({ edit: updated as unknown as RevisionEditRow, feedback: fb.data });
}

/**
 * Ubah: the COO's wording replaces the AI's. Reject the AI change, apply the
 * COO text as a new tracked change under the COO's name, record feedback `edit`.
 */
export async function editRevision(
  db: Db,
  args: { reviewId: string; revisionId: string; editedText: string; userId: string; userEmail?: string },
): Promise<ServiceResult<ResolveResult>> {
  const editedText = args.editedText.trim();
  if (!editedText) return failure("validation", "Masukkan teks revisi terlebih dahulu.");
  const editR = await loadEdit(db, args.reviewId, args.revisionId);
  if (!editR.ok) return editR;
  const edit = editR.data;
  if (edit.error || !edit.change_id) return failure("conflict", "Revisi ini tidak terpetakan ke dokumen; gunakan umpan balik biasa.");
  if (edit.status !== "pending") return failure("conflict", "Revisi sudah diputuskan.");

  const reviewR = await loadReview(db, args.reviewId);
  if (!reviewR.ok) return reviewR;
  const review = reviewR.data;
  const rev = review.ai_output?.revisions.find((r) => r.id === args.revisionId);
  if (!rev) return failure("not_found", "Revisi tidak ditemukan pada hasil tinjauan.");

  const key = review.contract_redline_path ?? redlineDocxKey(args.reviewId);
  const bytes = await loadBytes(key);
  if (!bytes) return failure("not_found", "Berkas redline tidak dapat dibaca dari penyimpanan.");

  let applied;
  try {
    const ids = [edit.del_w_id, edit.ins_w_id].filter((v): v is string => Boolean(v));
    const rejected = await resolveTrackedChange(bytes, ids, "reject");
    const cooEdit = { ...revisionToEdit(rev, review.contract_text ?? ""), replace: editedText, reason: `Versi COO: ${rev.rationale ?? ""}`.trim() };
    applied = await applyTrackedEdits(rejected.bytes, [cooEdit], { author: cooAuthor(args.userEmail) });
    if (applied.errors.length > 0 || applied.changes.length === 0) {
      return failure("conflict", `Teks asli tidak dapat ditemukan lagi di dokumen (${applied.errors[0]?.reason ?? "tidak ada perubahan"}).`);
    }
    await storeBytes(key, applied.bytes);
  } catch (e) {
    return internalFailure(e);
  }

  const change = applied.changes[0];
  const { data: updated, error: uErr } = await db
    .from("review_revision_edits")
    .update({
      change_id: change.id,
      del_w_id: change.delId ?? null,
      ins_w_id: change.insId ?? null,
      deleted_text: change.deletedText,
      inserted_text: change.insertedText,
      author: cooAuthor(args.userEmail),
      status: "accepted",
      updated_at: new Date().toISOString(),
    })
    .eq("id", edit.id)
    .select("*")
    .single();
  if (uErr || !updated) return internalFailure(uErr ?? new Error("Gagal memperbarui revisi."));

  const fb = await createFeedback(db, {
    reviewId: args.reviewId,
    userId: args.userId,
    input: { finding_type: "revision", finding_id: args.revisionId, action: "edit", original_text: rev.suggested_text, edited_text: editedText },
  });
  if (!fb.ok) return fb;
  return ok({ edit: updated as unknown as RevisionEditRow, feedback: fb.data });
}
