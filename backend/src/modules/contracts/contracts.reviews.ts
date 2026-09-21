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
import { listPromptRules } from "../playbook/playbook.service";
import { runContractReviewAi } from "./contracts.ai";
import { buildReviewContextFor } from "./contracts.context";
import { extractContract } from "./contracts.extract";
import { attachDocxBytesToReview, isStashedDocxKey } from "./contracts.files";
import type {
  ManualCommentRow,
  MissingClause,
  PlaybookComplianceItem,
  RedFlag,
  ReviewDetail,
  ReviewDetailRow,
  ReviewFeedbackRow,
  ReviewOutput,
} from "./contracts.types";
import { projectRevisions, type RevisionEditRow } from "./contracts.redline";
import type { NegotiationPointRow } from "./contracts.memo";

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
  contract_docx_path: string | null;
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
  const contractDocxPath = isStashedDocxKey(b.contract_docx_path) ? b.contract_docx_path : null;
  if (b.contract_docx_path && !contractDocxPath) return failure("validation", "contract_docx_path tidak valid.");
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
    contract_docx_path: contractDocxPath,
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

export type ReviewRunInput = Pick<
  CreateReviewInput,
  "contract_text" | "client_name" | "document_type" | "project_context" | "review_focus"
>;

export type ReviewRunResult = {
  review_id: string;
  risk_level: string | null;
  recommendation: string | null;
  ai_output: ReviewOutput;
};

/**
 * Run the AI review and write the result onto the row. Awaitable: the caller
 * (a detached HTTP handler or the Assistant's review_contract tool) gets the
 * outcome back. On any failure the row is flipped to "failed" first so the
 * workspace never spins forever, then the failure is returned, not thrown.
 */
export async function executeReview(
  db: Db,
  reviewId: string,
  input: ReviewRunInput,
): Promise<ServiceResult<ReviewRunResult>> {
  try {
    // Mike owns the playbook and calls the model directly (OpenRouter): the
    // active rules go into the system prompt on every review, so an edit on
    // /playbook applies to the next review with no redeploy (Janus parity).
    const [ctx, playbookRules] = await Promise.all([
      buildReviewContextFor(db, input.client_name, input.document_type),
      listPromptRules(db),
    ]);
    if (playbookRules.length === 0) {
      return await markFailed(db, reviewId, failure("unavailable", "Tidak ada aturan playbook aktif; tinjauan dibatalkan."));
    }
    const ai: unknown = await runContractReviewAi({
      rules: playbookRules,
      input: {
        contract_text: input.contract_text,
        client_name: input.client_name,
        document_type: input.document_type,
        project_context: input.project_context,
        review_focus: input.review_focus,
        clause_library_context: ctx.clauseLibraryContext,
        past_feedback_context: ctx.pastFeedbackContext,
      },
    });
    if (!isReviewOutput(ai)) {
      return await markFailed(
        db,
        reviewId,
        internalFailure(new Error(`review AI returned invalid output: ${JSON.stringify(ai).slice(0, 300)}`)),
      );
    }
    const risk_level = (ai.risk_level as string | undefined) ?? null;
    const recommendation = (ai.overall_recommendation as string | undefined) ?? null;
    const { error } = await db
      .from("reviews")
      .update({
        ai_output: ai,
        risk_level,
        recommendation,
        status: "ai_reviewed",
        lifecycle_stage: "ai_review",
      })
      .eq("id", reviewId);
    if (error) return await markFailed(db, reviewId, internalFailure(error));
    // Best effort: turn the AI revisions into tracked changes in the stored DOCX.
    // Failure here never fails the review; the workspace can re-run it on demand.
    try {
      const projected = await projectRevisions(db, { reviewId });
      if (!projected.ok) console.warn(`[contracts] revision projection skipped for ${reviewId}:`, projected);
    } catch (e) {
      console.warn(`[contracts] revision projection crashed for ${reviewId}:`, e);
    }
    return ok({ review_id: reviewId, risk_level, recommendation, ai_output: ai as unknown as ReviewOutput });
  } catch (e) {
    return await markFailed(db, reviewId, internalFailure(e));
  }
}

async function markFailed<T>(db: Db, reviewId: string, result: ServiceResult<T>): Promise<ServiceResult<T>> {
  console.error(`[contracts] review ${reviewId} failed:`, result);
  try {
    await db.from("reviews").update({ status: "failed" }).eq("id", reviewId);
  } catch (e2) {
    console.error(`[contracts] failed to mark ${reviewId} failed:`, e2);
  }
  return result;
}

/**
 * Fire-and-forget form of executeReview for the HTTP route, which answers 201
 * before the ~60-120s review finishes. Never throws.
 */
export async function runReview(db: Db, reviewId: string, input: ReviewRunInput): Promise<void> {
  await executeReview(db, reviewId, input);
}

export type CreateReviewFromDocxInput = {
  userId: string;
  buffer: Buffer;
  filename: string;
  client_name: string;
  document_type: string;
  project_context: string;
  review_focus: string[];
  title?: string | null;
};

/**
 * One-call entry for callers that already hold the DOCX bytes (the Assistant's
 * review_contract tool): extract → insert the `processing` row → persist the
 * original DOCX. Does NOT run the AI review; follow with executeReview.
 */
export async function createReviewFromDocx(
  db: Db,
  input: CreateReviewFromDocxInput,
): Promise<ServiceResult<{ id: string; input: ReviewRunInput }>> {
  const clientName = input.client_name.trim();
  if (!clientName) return failure("validation", "client_name wajib diisi.");
  const extracted = await extractContract({ buffer: input.buffer, filename: input.filename });
  if (!extracted.ok) return extracted;
  const documentType = input.document_type.trim() || "Other";
  const title =
    input.title?.trim() || extracted.data.filename.replace(/\.(docx|doc)$/i, "") || `${documentType} — ${clientName}`;
  const reviewInput: CreateReviewInput = {
    client_name: clientName,
    contract_text: extracted.data.contract_text,
    document_type: documentType,
    project_context: input.project_context,
    review_focus: input.review_focus,
    contract_html: extracted.data.contract_html,
    contract_filename: extracted.data.filename,
    contract_docx_path: null,
    title,
  };
  const created = await createReview(db, { userId: input.userId, input: reviewInput });
  if (!created.ok) return created;
  const attached = await attachDocxBytesToReview(db, { reviewId: created.data.id, buffer: input.buffer });
  if (!attached.ok) console.warn(`[contracts] could not attach DOCX to ${created.data.id}:`, attached);
  return ok({
    id: created.data.id,
    input: {
      contract_text: reviewInput.contract_text,
      client_name: reviewInput.client_name,
      document_type: reviewInput.document_type,
      project_context: reviewInput.project_context,
      review_focus: reviewInput.review_focus,
    },
  });
}

export type ReviewSummary = {
  risk_level: string | null;
  overall_recommendation: string | null;
  executive_summary: string;
  counts: {
    red_flags: number;
    revisions: number;
    clarifications: number;
    missing_clauses: number;
    yellow_flags: number;
    positive_findings: number;
  };
  red_flags: Array<
    Pick<RedFlag, "id" | "severity" | "clause" | "title" | "action" | "playbook_rule"> & { highlight_text: string | null }
  >;
  red_flags_omitted: number;
  missing_clauses: Array<Pick<MissingClause, "clause_name" | "importance">>;
  non_compliant_rules: Array<{
    rule: string;
    status: PlaybookComplianceItem["status"];
    clause_reference: string | null;
    playbook_threshold: string | null;
  }>;
};

const SEVERITY_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };

/**
 * Compact, model-facing digest of a ReviewOutput. Red flags are ordered by
 * severity and capped so the tool result stays small; the workspace has the
 * full picture.
 */
export function summarizeReviewOutput(ai: ReviewOutput, opts: { maxFlags?: number } = {}): ReviewSummary {
  const maxFlags = opts.maxFlags ?? 8;
  const flags = [...(ai.red_flags ?? [])].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
  );
  const compliance = ai.playbook_compliance ?? {};
  return {
    risk_level: ai.risk_level ?? null,
    overall_recommendation: ai.overall_recommendation ?? null,
    executive_summary: ai.executive_summary ?? "",
    counts: {
      red_flags: ai.red_flags?.length ?? 0,
      revisions: ai.revisions?.length ?? 0,
      clarifications: ai.clarifications?.length ?? 0,
      missing_clauses: ai.missing_clauses?.length ?? 0,
      yellow_flags: ai.yellow_flags?.length ?? 0,
      positive_findings: ai.positive_findings?.length ?? 0,
    },
    red_flags: flags.slice(0, maxFlags).map((f) => ({
      id: f.id,
      severity: f.severity,
      clause: f.clause,
      title: f.title,
      action: f.action,
      playbook_rule: f.playbook_rule,
      highlight_text: f.highlight_text ?? null,
    })),
    red_flags_omitted: Math.max(0, flags.length - maxFlags),
    missing_clauses: (ai.missing_clauses ?? []).map((m) => ({ clause_name: m.clause_name, importance: m.importance })),
    non_compliant_rules: Object.entries(compliance)
      .filter(([, item]) => item && (item.status === "non_compliant" || item.status === "needs_attention"))
      .map(([rule, item]) => ({
        rule,
        status: item.status,
        clause_reference: item.clause_reference ?? null,
        playbook_threshold: item.playbook_threshold ?? null,
      })),
  };
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

  const [
    { data: feedback, error: fbError },
    { data: comments, error: cError },
    { data: edits, error: eError },
    { data: points, error: pError },
  ] = await Promise.all([
    db.from("review_feedback").select("*").eq("review_id", reviewId).order("created_at", { ascending: true }),
    db.from("manual_comments").select("*").eq("review_id", reviewId).order("created_at", { ascending: true }),
    db.from("review_revision_edits").select("*").eq("review_id", reviewId).order("created_at", { ascending: true }),
    db.from("negotiation_points").select("*").eq("review_id", reviewId),
  ]);
  if (fbError) return internalFailure(fbError);
  if (cError) return internalFailure(cError);
  if (eError) return internalFailure(eError);
  if (pError) return internalFailure(pError);

  return ok({
    review: review as unknown as ReviewDetailRow,
    feedback: (feedback ?? []) as unknown as ReviewFeedbackRow[],
    comments: (comments ?? []) as unknown as ManualCommentRow[],
    revisionEdits: (edits ?? []) as unknown as RevisionEditRow[],
    negotiationPoints: (points ?? []) as unknown as NegotiationPointRow[],
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
