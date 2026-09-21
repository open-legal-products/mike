// Original-contract DOCX persistence for the review workspace.
//
// The bytes live in Mike's object storage under contracts/…, referenced from
// reviews.contract_docx_path (Janus column, previously unused in Mike). They
// are deliberately NOT registered as Mike `documents` rows: Janus reviews are
// team-wide while Mike documents are owner-scoped, and the workspace streams
// the file through /contracts/:id/file instead. Storage is optional: when it
// is not configured the review still works in the HTML-fallback mode.

import { randomUUID } from "node:crypto";
import type { Db } from "../../lib/supabase";
import {
  copyFile,
  deleteFile,
  headFile,
  storageEnabled,
  uploadFile,
} from "../../lib/storage";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const UPLOAD_PREFIX = "contracts/uploads/";

export function originalDocxKey(reviewId: string): string {
  return `contracts/${reviewId}/original.docx`;
}

/** Park the uploaded DOCX so `POST /contracts` can attach it to the row it creates. */
export async function stashUploadedDocx(buffer: Buffer): Promise<string | null> {
  if (!storageEnabled) return null;
  const key = `${UPLOAD_PREFIX}${randomUUID()}.docx`;
  const bytes = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(bytes).set(buffer);
  await uploadFile(key, bytes, DOCX_MIME);
  return key;
}

export function isStashedDocxKey(value: unknown): value is string {
  return typeof value === "string" && /^contracts\/uploads\/[0-9a-f-]{36}\.docx$/.test(value);
}

/** Move the stashed upload to its permanent key and record it on the review. */
export async function attachDocxToReview(
  db: Db,
  args: { reviewId: string; stashedKey: string },
): Promise<ServiceResult<{ contract_docx_path: string }>> {
  if (!storageEnabled) return failure("unavailable", "Penyimpanan dokumen belum dikonfigurasi.");
  const target = originalDocxKey(args.reviewId);
  try {
    await copyFile(args.stashedKey, target);
  } catch (e) {
    return internalFailure(e);
  }
  try {
    await deleteFile(args.stashedKey);
  } catch {
    // The stash is best-effort garbage; the copy is what matters.
  }
  const { error } = await db.from("reviews").update({ contract_docx_path: target }).eq("id", args.reviewId);
  if (error) return internalFailure(error);
  return ok({ contract_docx_path: target });
}

/**
 * Persist DOCX bytes a caller already holds (the Assistant's review_contract
 * tool reads the attached chat document) straight to the permanent key.
 */
export async function attachDocxBytesToReview(
  db: Db,
  args: { reviewId: string; buffer: Buffer },
): Promise<ServiceResult<{ contract_docx_path: string }>> {
  if (!storageEnabled) return failure("unavailable", "Penyimpanan dokumen belum dikonfigurasi.");
  const target = originalDocxKey(args.reviewId);
  try {
    const bytes = new ArrayBuffer(args.buffer.byteLength);
    new Uint8Array(bytes).set(args.buffer);
    await uploadFile(target, bytes, DOCX_MIME);
  } catch (e) {
    return internalFailure(e);
  }
  const { error } = await db.from("reviews").update({ contract_docx_path: target }).eq("id", args.reviewId);
  if (error) return internalFailure(error);
  return ok({ contract_docx_path: target });
}

export type ReviewFileSource = { key: string; filename: string; size: number | null };

/** Resolve the streamable original for a review, or not_found when none was persisted. */
export async function getReviewFileSource(
  db: Db,
  reviewId: string,
  variant: "current" | "original" = "current",
): Promise<ServiceResult<ReviewFileSource>> {
  const { data, error } = await db
    .from("reviews")
    .select("contract_docx_path, contract_redline_path, contract_filename, title")
    .eq("id", reviewId)
    .maybeSingle();
  if (error) return internalFailure(error);
  const row = data as {
    contract_docx_path: string | null;
    contract_redline_path: string | null;
    contract_filename: string | null;
    title: string | null;
  } | null;
  if (!row) return failure("not_found", "Tinjauan tidak ditemukan.");
  // The working redline (when projected) is what the reviewer should see; the
  // untouched upload is available with variant "original".
  const key = variant === "original" ? row.contract_docx_path : row.contract_redline_path ?? row.contract_docx_path;
  if (!key) return failure("not_found", "Kontrak asli DOCX tidak ditemukan.");
  if (!storageEnabled) return failure("unavailable", "Penyimpanan dokumen belum dikonfigurasi.");
  const meta = await headFile(key);
  const base = (row.contract_filename || `${row.title ?? "kontrak"}.docx`).replace(/\.docx$/i, "");
  const filename = key === row.contract_redline_path ? `${base} - Redline.docx` : `${base}.docx`;
  return ok({ key, filename, size: meta?.size ?? null });
}
