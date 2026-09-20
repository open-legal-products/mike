// Business logic + data access for contract reviews (the Janus review model
// ported into Mike). Every function takes the service-role `db` first and
// returns a ServiceResult; nothing here touches req/res.
//
// Scope: reviews are TEAM-WIDE (Janus's is_team_member model), so list/status
// deliberately do not filter by user_id. requireAuth gates the surface and the
// service-role client bypasses RLS. Multi-tenant deployments must re-apply a
// team predicate here from the caller identity.

import type { Db } from "../../lib/supabase";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { callJanusTool } from "../../lib/janusTools";
import { buildReviewContextFor } from "./contracts.context";
import type { ManualCommentRow, ReviewDetail, ReviewDetailRow, ReviewFeedbackRow } from "./contracts.types";

// Narrow list payload — the dashboard never needs contract_text/contract_html/
// ai_output, which are large. Keep in sync with the columns the dashboard renders.
const LIST_COLUMNS =
  "id, user_id, title, client_name, document_type, risk_level, recommendation, status, created_at, expiry_date";

export type ReviewListRow = {
  id: string;
  user_id: string | null;
  title: string | null;
  client_name: string | null;
  document_type: string | null;
  risk_level: string | null;
  recommendation: string | null;
  status: string | null;
  created_at: string;
  expiry_date: string | null;
};

export type ReviewListItem = ReviewListRow & { uploader_email: string | null };

export type ReviewStatus = {
  id: string;
  status: string | null;
  risk_level: string | null;
  recommendation: string | null;
};

export type CallerIdentity = { userId: string; email: string | null; isAdmin: boolean };

export type CreateReviewInput = {
  client_name: string;
  contract_text: string;
  document_type: string;
  project_context: string;
  review_focus: string[];
  contract_html: string | null;
  contract_filename: string | null;
  title: string;
};

export async function callerIsAdmin(db: Db, userId: string): Promise<boolean> {
  const { data } = await db
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  return Boolean(data);
}

/** Identity + role for client-side gating; authorization stays server-side. */
export async function getCallerIdentity(
  db: Db,
  args: { userId: string; email?: string },
): Promise<ServiceResult<CallerIdentity>> {
  const isAdmin = await callerIsAdmin(db, args.userId);
  return ok({ userId: args.userId, email: args.email || null, isAdmin });
}

/** Team-wide review list for the dashboard, enriched with the uploader email. */
export async function listReviews(db: Db): Promise<ServiceResult<ReviewListItem[]>> {
  const { data, error } = await db
    .from("reviews")
    .select(LIST_COLUMNS)
    .order("created_at", { ascending: false });
  if (error) return internalFailure(error);

  const reviews = (data ?? []) as unknown as ReviewListRow[];

  // Resolve uploader emails via the auth admin API. Do NOT use the
  // get_user_emails RPC: it is gated by is_team_member(), which reads the
  // caller's JWT, and the service-role client has none, so it returns nothing.
  const userIds = [...new Set(reviews.map((r) => r.user_id).filter((v): v is string => Boolean(v)))];
  const emailByUserId: Record<string, string> = {};
  await Promise.all(
    userIds.map(async (id) => {
      const { data: found } = await db.auth.admin.getUserById(id);
      if (found?.user?.email) emailByUserId[id] = found.user.email;
    }),
  );

  return ok(
    reviews.map((r) => ({
      ...r,
      uploader_email: r.user_id ? emailByUserId[r.user_id] ?? null : null,
    })),
  );
}

/** Normalize an untrusted request body into a CreateReviewInput, or a validation failure. */
export function parseCreateReviewBody(body: unknown): ServiceResult<CreateReviewInput> {
  const b = (body ?? {}) as Record<string, unknown>;
  const clientName = typeof b.client_name === "string" ? b.client_name.trim() : "";
  const contractText = typeof b.contract_text === "string" ? b.contract_text : "";
  const documentType =
    typeof b.document_type === "string" && b.document_type.trim() ? b.document_type.trim() : "Other";
  const projectContext = typeof b.project_context === "string" ? b.project_context : "";
  const reviewFocus = Array.isArray(b.review_focus)
    ? (b.review_focus as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const contractHtml = typeof b.contract_html === "string" ? b.contract_html : null;
  const contractFilename = typeof b.contract_filename === "string" ? b.contract_filename : null;
  const title =
    typeof b.title === "string" && b.title.trim() ? b.title.trim() : `${documentType} — ${clientName}`;

  if (!clientName) return failure("validation", "client_name wajib diisi.");
  if (!contractText.trim()) return failure("validation", "contract_text wajib diisi.");

  return ok({
    client_name: clientName,
    contract_text: contractText,
    document_type: documentType,
    project_context: projectContext,
    review_focus: reviewFocus,
    contract_html: contractHtml,
    contract_filename: contractFilename,
    title,
  });
}

/** Insert the review row in `processing` and upsert the client. Does NOT run the AI review. */
export async function createReview(
  db: Db,
  args: { userId: string; input: CreateReviewInput },
): Promise<ServiceResult<{ id: string; status: "processing" }>> {
  const { input } = args;
  const { data: review, error } = await db
    .from("reviews")
    .insert({
      user_id: args.userId,
      title: input.title,
      client_name: input.client_name,
      document_type: input.document_type,
      contract_filename: input.contract_filename,
      contract_text: input.contract_text,
      contract_html: input.contract_html,
      project_context: input.project_context,
      review_focus: input.review_focus,
      status: "processing",
    })
    .select("id")
    .single();
  if (error || !review) return internalFailure(error ?? new Error("Gagal membuat tinjauan."));

  await db.from("clients").upsert({ name: input.client_name }, { onConflict: "name" });

  return ok({ id: (review as { id: string }).id, status: "processing" });
}

/** Minimal shape check so a parseable-but-wrong payload is never stored as a finished review. */
export function isReviewOutput(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const ai = value as Record<string, unknown>;
  if ("error" in ai) return false;
  return Boolean(ai.risk_level || ai.overall_recommendation);
}

/**
 * Run the AI review through janus-tools and write the result onto the row.
 * Detached from the HTTP response by the caller; catches its own errors and
 * flips the row to "failed" so the UI never spins forever.
 */
export async function runReview(
  db: Db,
  reviewId: string,
  input: Pick<CreateReviewInput, "contract_text" | "client_name" | "document_type" | "project_context" | "review_focus">,
): Promise<void> {
  try {
    const ctx = await buildReviewContextFor(db, input.client_name, input.document_type);
    const text = await callJanusTool("run_contract_review", {
      contract_text: input.contract_text,
      client_name: input.client_name,
      document_type: input.document_type,
      project_context: input.project_context,
      review_focus: input.review_focus,
      clause_library_context: ctx.clauseLibraryContext,
      past_feedback_context: ctx.pastFeedbackContext,
    });
    const ai: unknown = JSON.parse(text);
    if (!isReviewOutput(ai)) {
      throw new Error(`review-contract returned invalid output: ${text.slice(0, 300)}`);
    }
    await db
      .from("reviews")
      .update({
        ai_output: ai,
        risk_level: (ai.risk_level as string | undefined) ?? null,
        recommendation: (ai.overall_recommendation as string | undefined) ?? null,
        status: "ai_reviewed",
      })
      .eq("id", reviewId);
  } catch (e) {
    console.error(`[contracts] runReview failed for ${reviewId}:`, e);
    try {
      await db.from("reviews").update({ status: "failed" }).eq("id", reviewId);
    } catch (e2) {
      console.error(`[contracts] failed to mark ${reviewId} failed:`, e2);
    }
  }
}

/**
 * Everything the workspace page needs in one round trip: the full review row
 * (contract text/HTML + ai_output), every feedback row, and every manual
 * comment (replies included; the client groups them by parent_comment_id).
 */
export async function getReviewDetail(db: Db, reviewId: string): Promise<ServiceResult<ReviewDetail>> {
  const { data: review, error } = await db.from("reviews").select("*").eq("id", reviewId).maybeSingle();
  if (error) return internalFailure(error);
  if (!review) return failure("not_found", "Tinjauan tidak ditemukan.");

  const [{ data: feedback, error: fbError }, { data: comments, error: cError }] = await Promise.all([
    db.from("review_feedback").select("*").eq("review_id", reviewId).order("created_at", { ascending: true }),
    db.from("manual_comments").select("*").eq("review_id", reviewId).order("created_at", { ascending: true }),
  ]);
  if (fbError) return internalFailure(fbError);
  if (cError) return internalFailure(cError);

  return ok({
    review: review as unknown as ReviewDetailRow,
    feedback: (feedback ?? []) as unknown as ReviewFeedbackRow[],
    comments: (comments ?? []) as unknown as ManualCommentRow[],
  });
}

export async function getReviewStatus(db: Db, reviewId: string): Promise<ServiceResult<ReviewStatus>> {
  const { data, error } = await db
    .from("reviews")
    .select("id, status, risk_level, recommendation")
    .eq("id", reviewId)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!data) return failure("not_found", "Tinjauan tidak ditemukan.");
  return ok(data as unknown as ReviewStatus);
}

/** Admin-only (role-based via user_roles, enforced here, not in the client). */
export async function deleteReview(
  db: Db,
  args: { userId: string; reviewId: string },
): Promise<ServiceResult<null>> {
  if (!(await callerIsAdmin(db, args.userId))) return failure("forbidden", "Admin role required");
  const { error } = await db.from("reviews").delete().eq("id", args.reviewId);
  if (error) return internalFailure(error);
  return ok(null);
}
