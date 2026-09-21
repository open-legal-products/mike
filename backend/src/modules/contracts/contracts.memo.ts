// Negotiation memo (Phase 5 slice 5). Mike owns the data: this module assembles
// the review, its C-level feedback and up to 3 past memos for the same client,
// sends them to the janus-tools `run_negotiation_memo` proxy (AI stays on
// Lovable), and stores the memo on the review. Per-point BD status lives in
// negotiation_points (Janus table): pending | agreed | rejected | escalated.

import { z } from "zod";
import type { Db } from "../../lib/supabase";
import { generateMemoAi, type MemoFeedbackRow } from "./contracts.ai";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import type { NegotiationMemo, ReviewOutput } from "./contracts.types";

export const NEGOTIATION_STATUSES = ["pending", "agreed", "rejected", "escalated"] as const;
export type NegotiationStatus = (typeof NEGOTIATION_STATUSES)[number];

export interface NegotiationPointRow {
  id: string;
  review_id: string;
  point_id: string;
  status: NegotiationStatus;
  client_response: string | null;
  updated_by: string | null;
  updated_at: string;
}

export function isNegotiationMemo(value: unknown): value is NegotiationMemo {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return typeof m.memo_title === "string" && Array.isArray(m.must_change) && Array.isArray(m.should_change);
}

export async function generateNegotiationMemo(
  db: Db,
  args: { reviewId: string },
): Promise<ServiceResult<{ memo: NegotiationMemo; generated_at: string }>> {
  const { data: review, error } = await db
    .from("reviews")
    .select("id, title, client_name, document_type, ai_output")
    .eq("id", args.reviewId)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!review) return failure("not_found", "Tinjauan tidak ditemukan.");
  const row = review as { id: string; title: string | null; client_name: string | null; document_type: string | null; ai_output: ReviewOutput | null };
  if (!row.ai_output) return failure("conflict", "Tinjauan belum memiliki hasil AI.");

  const [{ data: feedback, error: fbError }, { data: past, error: pastError }] = await Promise.all([
    db.from("review_feedback").select("finding_type, finding_id, action, rationale, edited_text").eq("review_id", args.reviewId),
    db
      .from("reviews")
      .select("id, title, negotiation_memo")
      .eq("client_name", row.client_name ?? "")
      .order("created_at", { ascending: false })
      .limit(8),
  ]);
  if (fbError) return internalFailure(fbError);
  if (pastError) return internalFailure(pastError);
  // Tone continuity: up to 3 earlier memos for the same client (never this review).
  const pastMemos = ((past ?? []) as Array<{ id: string; title: string | null; negotiation_memo: unknown }>)
    .filter((r) => r.id !== args.reviewId && r.negotiation_memo)
    .slice(0, 3)
    .map((r) => ({ title: r.title ?? "", negotiation_memo: r.negotiation_memo }));

  let memo: unknown;
  try {
    memo = await generateMemoAi({
      title: row.title ?? "Kontrak",
      client_name: row.client_name ?? "",
      document_type: row.document_type ?? "Other",
      ai_output: row.ai_output,
      feedback: (feedback ?? []) as MemoFeedbackRow[],
      past_memos: pastMemos,
    });
  } catch (e) {
    return internalFailure(e);
  }
  if (!isNegotiationMemo(memo)) return failure("conflict", "Memo yang dihasilkan tidak valid.");

  const generated_at = new Date().toISOString();
  const { error: uErr } = await db
    .from("reviews")
    .update({ negotiation_memo: memo, negotiation_memo_generated_at: generated_at })
    .eq("id", args.reviewId);
  if (uErr) return internalFailure(uErr);
  return ok({ memo, generated_at });
}

export async function listNegotiationPoints(db: Db, reviewId: string): Promise<ServiceResult<NegotiationPointRow[]>> {
  const { data, error } = await db.from("negotiation_points").select("*").eq("review_id", reviewId);
  if (error) return internalFailure(error);
  return ok((data ?? []) as unknown as NegotiationPointRow[]);
}

const pointStatusSchema = z.object({
  status: z.enum(NEGOTIATION_STATUSES),
  client_response: z.string().trim().max(20_000).nullish(),
});

export function parsePointStatusBody(body: unknown): ServiceResult<z.infer<typeof pointStatusSchema>> {
  const parsed = pointStatusSchema.safeParse(body);
  if (!parsed.success) return failure("validation", parsed.error.issues[0]?.message ?? "Invalid body");
  return ok(parsed.data);
}

export async function upsertNegotiationPoint(
  db: Db,
  args: { reviewId: string; pointId: string; userId: string; status: NegotiationStatus; clientResponse?: string | null },
): Promise<ServiceResult<NegotiationPointRow>> {
  if (!/^NEG-[A-Z]+-\d{3}$/.test(args.pointId)) return failure("validation", "point_id tidak valid.");
  const { data, error } = await db
    .from("negotiation_points")
    .upsert(
      {
        review_id: args.reviewId,
        point_id: args.pointId,
        status: args.status,
        client_response: args.clientResponse ?? null,
        updated_by: args.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "review_id,point_id" },
    )
    .select("*")
    .single();
  if (error || !data) return internalFailure(error ?? new Error("Gagal menyimpan status."));
  return ok(data as unknown as NegotiationPointRow);
}
