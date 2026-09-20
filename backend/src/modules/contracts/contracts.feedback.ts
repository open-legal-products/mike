// Write side of the contract-review feedback loop (the Janus "moat"): every
// C-level action on a finding, manual comments, AI-missed-clause signals,
// clause-library saves, and review metadata (lifecycle, dates, override).
//
// The review_feedback key space and action verbs are a contract shared with
// the prompt-context builder (contracts.context.ts) and the negotiation memo:
//   finding_type:finding_id  e.g. red_flag:RF-001, revision:REV-001,
//   clarification:CLR-001, missing_clause:MC-0, financial:FIN-0,
//   playbook_rule:<slug>, executive_summary:overall_recommendation
//   actions: valid | adjust | dismiss | accept | edit | reject | answered | skip | override
// `rationale` carries a clarification's answer; `edited_text` is set only for `edit`.

import { z } from "zod";
import type { Db } from "../../lib/supabase";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import type { ManualCommentRow, ReviewFeedbackRow } from "./contracts.types";

export const FEEDBACK_ACTIONS = [
  "valid",
  "adjust",
  "dismiss",
  "accept",
  "edit",
  "reject",
  "answered",
  "skip",
  "override",
] as const;
export type FeedbackAction = (typeof FEEDBACK_ACTIONS)[number];

/** Actions that discard a finding; Janus requires a written reason for them. */
const RATIONALE_REQUIRED: ReadonlySet<string> = new Set(["dismiss", "reject", "skip"]);

const nullableText = z.string().trim().max(20_000).nullish();

const feedbackSchema = z.object({
  finding_type: z.string().trim().min(1).max(64),
  finding_id: z.string().trim().min(1).max(64),
  action: z.enum(FEEDBACK_ACTIONS),
  original_severity: nullableText,
  adjusted_severity: nullableText,
  original_text: nullableText,
  edited_text: nullableText,
  rationale: nullableText,
});
export type FeedbackInput = z.infer<typeof feedbackSchema>;

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid body";
}

export function parseFeedbackBody(body: unknown): ServiceResult<FeedbackInput> {
  const parsed = feedbackSchema.safeParse(body);
  if (!parsed.success) return failure("validation", firstIssue(parsed.error));
  const input = parsed.data;
  if (RATIONALE_REQUIRED.has(input.action) && !input.rationale) {
    return failure("validation", "Alasan wajib diisi untuk tindakan ini.");
  }
  if (input.action === "edit" && !input.edited_text) {
    return failure("validation", "Masukkan teks revisi terlebih dahulu.");
  }
  if (input.action === "answered" && !input.rationale) {
    return failure("validation", "Jawaban wajib diisi.");
  }
  return ok(input);
}

export function parseFeedbackBulkBody(body: unknown): ServiceResult<FeedbackInput[]> {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || items.length === 0) return failure("validation", "items wajib diisi.");
  if (items.length > 200) return failure("validation", "Maksimum 200 temuan per aksi massal.");
  const out: FeedbackInput[] = [];
  for (const item of items) {
    const r = parseFeedbackBody(item);
    if (!r.ok) return r;
    out.push(r.data);
  }
  return ok(out);
}

function toRow(reviewId: string, userId: string, input: FeedbackInput) {
  return {
    review_id: reviewId,
    user_id: userId,
    finding_type: input.finding_type,
    finding_id: input.finding_id,
    action: input.action,
    original_severity: input.original_severity ?? null,
    adjusted_severity: input.adjusted_severity || null,
    original_text: input.original_text ?? null,
    edited_text: input.action === "edit" ? input.edited_text ?? null : null,
    rationale: input.rationale || null,
  };
}

export async function createFeedback(
  db: Db,
  args: { reviewId: string; userId: string; input: FeedbackInput },
): Promise<ServiceResult<ReviewFeedbackRow>> {
  const { data, error } = await db
    .from("review_feedback")
    .insert(toRow(args.reviewId, args.userId, args.input))
    .select("*")
    .single();
  if (error || !data) return internalFailure(error ?? new Error("Gagal menyimpan umpan balik."));
  return ok(data as unknown as ReviewFeedbackRow);
}

export async function createFeedbackBulk(
  db: Db,
  args: { reviewId: string; userId: string; inputs: FeedbackInput[] },
): Promise<ServiceResult<ReviewFeedbackRow[]>> {
  const { data, error } = await db
    .from("review_feedback")
    .insert(args.inputs.map((input) => toRow(args.reviewId, args.userId, input)))
    .select("*");
  if (error) return internalFailure(error);
  return ok((data ?? []) as unknown as ReviewFeedbackRow[]);
}

// ── Manual comments + AI-missed signals ────────────────────────────────────

export const COMMENT_TYPES = ["note", "revision_suggestion", "question", "red_flag"] as const;

const commentSchema = z.object({
  comment_type: z.enum(COMMENT_TYPES),
  comment_text: z.string().trim().min(1).max(20_000),
  highlight_text: nullableText,
  highlight_start: z.number().int().nonnegative().nullish(),
  highlight_end: z.number().int().nonnegative().nullish(),
  suggested_text: nullableText,
  parent_comment_id: z.string().uuid().nullish(),
});
export type CommentInput = z.infer<typeof commentSchema>;

export function parseCommentBody(body: unknown): ServiceResult<CommentInput> {
  const parsed = commentSchema.safeParse(body);
  if (!parsed.success) return failure("validation", firstIssue(parsed.error));
  return ok(parsed.data);
}

/** Janus shows the commenter as the email's local part. */
export function displayNameFromEmail(email: string | undefined | null): string {
  const local = (email ?? "").split("@")[0]?.trim();
  return local || "User";
}

export async function createComment(
  db: Db,
  args: { reviewId: string; userId: string; userEmail?: string; input: CommentInput },
): Promise<ServiceResult<ManualCommentRow>> {
  const { input } = args;
  const { data, error } = await db
    .from("manual_comments")
    .insert({
      review_id: args.reviewId,
      user_id: args.userId,
      user_name: displayNameFromEmail(args.userEmail),
      comment_type: input.comment_type,
      highlight_text: input.highlight_text ?? null,
      highlight_start: input.highlight_start ?? null,
      highlight_end: input.highlight_end ?? null,
      comment_text: input.comment_text,
      suggested_text: input.comment_type === "revision_suggestion" ? input.suggested_text ?? null : null,
      parent_comment_id: input.parent_comment_id ?? null,
    })
    .select("*")
    .single();
  if (error || !data) return internalFailure(error ?? new Error("Gagal menyimpan komentar."));
  return ok(data as unknown as ManualCommentRow);
}

export const MISSED_CATEGORIES = ["red_flag", "revision", "clarification", "missing_clause", "yellow_flag"] as const;

const missedClauseSchema = z.object({
  highlight_text: z.string().trim().min(1).max(20_000),
  highlight_start: z.number().int().nonnegative().nullish(),
  highlight_end: z.number().int().nonnegative().nullish(),
  suggested_category: z.enum(MISSED_CATEGORIES),
  user_note: z.string().trim().min(1).max(20_000),
});
export type MissedClauseInput = z.infer<typeof missedClauseSchema>;

export function parseMissedClauseBody(body: unknown): ServiceResult<MissedClauseInput> {
  const parsed = missedClauseSchema.safeParse(body);
  if (!parsed.success) return failure("validation", firstIssue(parsed.error));
  return ok(parsed.data);
}

/** "AI melewatkan klausul ini" — a training signal, not a comment. */
export async function createMissedClauseSignal(
  db: Db,
  args: { reviewId: string; userId: string; input: MissedClauseInput },
): Promise<ServiceResult<{ id: string }>> {
  const { input } = args;
  const { data, error } = await db
    .from("missed_clause_feedback")
    .insert({
      review_id: args.reviewId,
      user_id: args.userId,
      highlight_text: input.highlight_text,
      highlight_start: input.highlight_start ?? null,
      highlight_end: input.highlight_end ?? null,
      suggested_category: input.suggested_category,
      user_note: input.user_note,
    })
    .select("id")
    .single();
  if (error || !data) return internalFailure(error ?? new Error("Gagal menyimpan sinyal."));
  return ok({ id: (data as { id: string }).id });
}

// ── Clause library ─────────────────────────────────────────────────────────

const clauseSchema = z.object({
  title: z.string().trim().min(1).max(500),
  wording: z.string().trim().min(1).max(50_000),
});
export type ClauseInput = z.infer<typeof clauseSchema>;

export function parseClauseBody(body: unknown): ServiceResult<ClauseInput> {
  const parsed = clauseSchema.safeParse(body);
  if (!parsed.success) return failure("validation", firstIssue(parsed.error));
  return ok(parsed.data);
}

/** Save an approved wording; `clevel_approved` rows feed the next review's prompt. */
export async function saveClauseToLibrary(
  db: Db,
  args: { reviewId: string; userId: string; input: ClauseInput },
): Promise<ServiceResult<{ id: string }>> {
  const { data: review, error: rError } = await db
    .from("reviews")
    .select("client_name")
    .eq("id", args.reviewId)
    .maybeSingle();
  if (rError) return internalFailure(rError);
  if (!review) return failure("not_found", "Tinjauan tidak ditemukan.");

  const { data, error } = await db
    .from("clause_library")
    .insert({
      title: args.input.title,
      wording: args.input.wording,
      source_type: "clevel_approved",
      source_review_id: args.reviewId,
      source_client_name: (review as { client_name: string | null }).client_name,
      approved_by: args.userId,
    })
    .select("id")
    .single();
  if (error || !data) return internalFailure(error ?? new Error("Gagal menyimpan klausul."));
  return ok({ id: (data as { id: string }).id });
}

// ── Review metadata (lifecycle, dates, override) ───────────────────────────

export const REVIEW_STATUSES = ["processing", "ai_reviewed", "clevel_reviewed", "signed", "archived", "failed"] as const;
export const LIFECYCLE_STAGES = [
  "draft",
  "ai_review",
  "clevel_review",
  "negotiation",
  "client_redline",
  "final_review",
  "signed",
  "active",
] as const;
export const RECOMMENDATIONS = ["READY_TO_SIGN", "NEEDS_REVISIONS", "ESCALATE_TO_CEO_COO", "DO_NOT_SIGN"] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD").nullable();

const reviewPatchSchema = z
  .object({
    status: z.enum(REVIEW_STATUSES).optional(),
    lifecycle_stage: z.enum(LIFECYCLE_STAGES).optional(),
    signing_date: isoDate.optional(),
    expiry_date: isoDate.optional(),
    renewal_date: isoDate.optional(),
    coo_recommendation_override: z.enum(RECOMMENDATIONS).nullable().optional(),
    coo_override_rationale: nullableText,
  })
  .strict();
export type ReviewPatch = z.infer<typeof reviewPatchSchema>;

/** Janus keeps the legacy `status` column in step with the lifecycle stage. */
export function statusForStage(stage: (typeof LIFECYCLE_STAGES)[number]): string | null {
  switch (stage) {
    case "ai_review":
      return "ai_reviewed";
    case "clevel_review":
    case "negotiation":
    case "client_redline":
    case "final_review":
      return "clevel_reviewed";
    case "signed":
    case "active":
      return "signed";
    default:
      return null;
  }
}

export function parseReviewPatch(body: unknown): ServiceResult<Record<string, unknown>> {
  const parsed = reviewPatchSchema.safeParse(body);
  if (!parsed.success) return failure("validation", firstIssue(parsed.error));
  const patch: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.lifecycle_stage && !parsed.data.status) {
    const synced = statusForStage(parsed.data.lifecycle_stage);
    if (synced) patch.status = synced;
  }
  if (Object.keys(patch).length === 0) return failure("validation", "Tidak ada perubahan.");
  return ok(patch);
}

export async function updateReviewMeta(
  db: Db,
  args: { reviewId: string; patch: Record<string, unknown> },
): Promise<ServiceResult<Record<string, unknown>>> {
  const { data, error } = await db
    .from("reviews")
    .update(args.patch)
    .eq("id", args.reviewId)
    .select(
      "id, status, lifecycle_stage, signing_date, expiry_date, renewal_date, coo_recommendation_override, coo_override_rationale",
    )
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!data) return failure("not_found", "Tinjauan tidak ditemukan.");
  return ok(data as Record<string, unknown>);
}
