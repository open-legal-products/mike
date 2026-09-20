// Clause-library + past-feedback context injected into the AI contract review.
//
// The pure builders are ported verbatim from Janus (janus-tools/agentActions.ts)
// so the prompt context Mike sends is byte-identical to what Janus sent. The
// queries run against MIKE's own tables: the moat (approved clauses, C-level
// corrections, missed-clause flags) lives here, not on the Lovable side.

import type { Db } from "../../lib/supabase";

export type ClauseContextRow = {
  title: string;
  wording: string;
  source_type: string;
  source_client_name: string | null;
};
export type FeedbackRow = {
  finding_type: string;
  finding_id: string;
  action: string;
  rationale: string | null;
};
export type MissedClauseRow = {
  highlight_text: string | null;
  suggested_category: string | null;
  user_note: string | null;
};

export function buildClauseLibraryContext(clauses: ClauseContextRow[]): string {
  if (!clauses || clauses.length === 0) return "";
  return clauses
    .map(
      (c) =>
        `CLAUSE: ${c.title}\nAPPROVED WORDING: ${c.wording}\nSOURCE: ${c.source_type} — ${c.source_client_name || "N/A"}\n---`,
    )
    .join("\n");
}

export function buildPastFeedbackContext(input: {
  clientName: string;
  docType: string;
  clientFeedback: FeedbackRow[];
  docTypeFeedback: FeedbackRow[];
  missedForClient: MissedClauseRow[];
  missedForDocType: MissedClauseRow[];
}): string {
  const { clientName, docType, clientFeedback, docTypeFeedback, missedForClient, missedForDocType } = input;
  let out = "";

  if (clientFeedback && clientFeedback.length > 0) {
    out += `PAST CORRECTIONS FOR ${clientName}:\n`;
    out += clientFeedback
      .map((f) => `- ${f.finding_type} ${f.finding_id}: C-Level ${f.action} — ${f.rationale || "no rationale"}`)
      .join("\n");
    out += "\n\n";
  }

  if (docTypeFeedback && docTypeFeedback.length > 0) {
    const counts: Record<string, { count: number; action: string; rationale: string | null }> = {};
    docTypeFeedback.forEach((f) => {
      const key = `${f.finding_type} ${f.finding_id}`;
      if (!counts[key]) counts[key] = { count: 0, action: f.action, rationale: f.rationale };
      counts[key].count++;
    });
    const top5 = Object.entries(counts)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5);
    if (top5.length > 0) {
      out += `COMMON OVERRIDES FOR ${docType} DOCUMENTS:\n`;
      out += top5
        .map(([key, v]) => `- ${key}: ${v.action} (${v.count}x) — ${v.rationale || "no rationale"}`)
        .join("\n");
      out += "\n\n";
    }
  }

  if (missedForClient && missedForClient.length > 0) {
    out += `AI MISSED CLAUSES FROM PAST ${clientName} REVIEWS (C-Level flagged these as missed by AI — pay attention to similar patterns):\n`;
    out += missedForClient
      .map((m) => `- "${(m.highlight_text || "").slice(0, 150)}" — should have been ${m.suggested_category || "flagged"}: ${m.user_note}`)
      .join("\n");
    out += "\n\n";
  }

  if (missedForDocType && missedForDocType.length > 0) {
    out += `AI MISSED CLAUSES FROM PAST ${docType} REVIEWS (cross-client patterns):\n`;
    out += missedForDocType
      .map((m) => `- "${(m.highlight_text || "").slice(0, 150)}" — should have been ${m.suggested_category || "flagged"}: ${m.user_note}`)
      .join("\n");
    out += "\n\n";
  }

  return out;
}

/** Assemble the review context from Mike's tables (mirrors Janus buildContextFor). */
export async function buildReviewContextFor(
  db: Db,
  clientName: string,
  docType: string,
): Promise<{ clauseLibraryContext: string; pastFeedbackContext: string }> {
  const { data: clauses } = await db
    .from("clause_library")
    .select("title, wording, source_type, source_client_name")
    .eq("is_archived", false)
    .order("times_used", { ascending: false })
    .limit(10);

  const { data: clientReviews } = await db.from("reviews").select("id").eq("client_name", clientName);
  const clientReviewIds = (clientReviews ?? []).map((r: { id: string }) => r.id);
  let clientFeedback: FeedbackRow[] = [];
  let missedForClient: MissedClauseRow[] = [];
  if (clientReviewIds.length > 0) {
    const { data: cf } = await db
      .from("review_feedback")
      .select("finding_type, finding_id, action, rationale")
      .in("review_id", clientReviewIds);
    clientFeedback = (cf ?? []) as FeedbackRow[];
    const { data: mc } = await db
      .from("missed_clause_feedback")
      .select("highlight_text, suggested_category, user_note")
      .in("review_id", clientReviewIds)
      .order("created_at", { ascending: false })
      .limit(10);
    missedForClient = (mc ?? []) as MissedClauseRow[];
  }

  const { data: docTypeReviews } = await db.from("reviews").select("id").eq("document_type", docType);
  const dtReviewIds = (docTypeReviews ?? []).map((r: { id: string }) => r.id);
  let docTypeFeedback: FeedbackRow[] = [];
  let missedForDocType: MissedClauseRow[] = [];
  if (dtReviewIds.length > 0) {
    const { data: dtf } = await db
      .from("review_feedback")
      .select("finding_type, finding_id, action, rationale")
      .in("review_id", dtReviewIds)
      .in("action", ["adjust", "dismiss", "override", "reject"]);
    docTypeFeedback = (dtf ?? []) as FeedbackRow[];
    const { data: md } = await db
      .from("missed_clause_feedback")
      .select("highlight_text, suggested_category, user_note")
      .in("review_id", dtReviewIds)
      .order("created_at", { ascending: false })
      .limit(10);
    missedForDocType = (md ?? []) as MissedClauseRow[];
  }

  return {
    clauseLibraryContext: buildClauseLibraryContext((clauses ?? []) as ClauseContextRow[]),
    pastFeedbackContext: buildPastFeedbackContext({
      clientName,
      docType,
      clientFeedback,
      docTypeFeedback,
      missedForClient,
      missedForDocType,
    }),
  };
}
