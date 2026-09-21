// Flat "annotation" view over a review: one row per AI finding plus one per
// root manual comment, each anchored to its position in the contract text.
// Feeds the Tabel tab (sort / filter / bulk actions) and the Komentar tab.
// Ported from Janus `useReviewState.annotations` + TabularReviewTab helpers.
//
// Key namespace matches review_feedback: red_flag:RF-001, revision:REV-001,
// clarification:CLR-001, yellow_flag:YF-<index>, positive:PF-<index>. Yellow
// flags carry no id in the AI output, so the index-based id is the contract
// shared with the prompt-context builder (Janus wrote yellow_flag rows with
// the same YF-<i> ids).

import type { ManualCommentRow, ReviewFeedbackRow, ReviewOutput } from "./reviewTypes";
import { feedbackKey } from "./reviewTypes";

export type AnnotationType = "red_flag" | "revision" | "clarification" | "yellow_flag" | "positive" | "manual";
export type AnnotationStatus = "pending" | "reviewed" | "dismissed";

export interface FindingAnnotation {
    /** Unique row key: `${type}:${id}`. */
    key: string;
    id: string;
    type: AnnotationType;
    highlightText: string;
    /** Character offset in contract_text, -1 when the quote could not be located. */
    position: number;
    severity?: string;
    clause: string;
    summary: string;
    playbookRule?: string;
    feedback?: ReviewFeedbackRow;
    comment?: ManualCommentRow;
}

export function locateQuote(text: string | null | undefined, quote: string | null | undefined): number {
    if (!text || !quote || quote.length < 5) return -1;
    const idx = text.indexOf(quote);
    if (idx !== -1) return idx;
    return text.toLowerCase().indexOf(quote.toLowerCase());
}

export function buildAnnotations(args: {
    output: ReviewOutput;
    comments: ManualCommentRow[];
    feedbackMap: Map<string, ReviewFeedbackRow>;
    contractText: string | null;
}): FindingAnnotation[] {
    const { output, comments, feedbackMap, contractText } = args;
    const rows: FindingAnnotation[] = [];
    const push = (a: Omit<FindingAnnotation, "key" | "position" | "feedback">) => {
        const key = feedbackKey(a.type, a.id);
        rows.push({ ...a, key, position: locateQuote(contractText, a.highlightText), feedback: feedbackMap.get(key) });
    };

    for (const f of output.red_flags ?? []) {
        push({ id: f.id, type: "red_flag", highlightText: f.highlight_text ?? "", severity: f.severity, clause: f.clause, summary: f.title || f.issue, playbookRule: f.playbook_rule });
    }
    for (const r of output.revisions ?? []) {
        push({ id: r.id, type: "revision", highlightText: r.highlight_text || r.original_text || "", severity: r.priority, clause: r.clause, summary: r.suggested_text || r.original_text });
    }
    for (const c of output.clarifications ?? []) {
        push({ id: c.id, type: "clarification", highlightText: c.highlight_text ?? "", clause: c.clause, summary: c.question });
    }
    (output.yellow_flags ?? []).forEach((y, i) => {
        push({ id: `YF-${i}`, type: "yellow_flag", highlightText: y.highlight_text ?? "", clause: y.clause ?? "—", summary: y.item || y.note });
    });
    (output.positive_findings ?? []).forEach((p, i) => {
        push({ id: `PF-${i}`, type: "positive", highlightText: p.highlight_text ?? "", clause: p.clause, summary: p.finding || p.clause });
    });
    for (const c of comments) {
        if (c.parent_comment_id) continue;
        const key = `manual:${c.id}`;
        const located = locateQuote(contractText, c.highlight_text);
        rows.push({
            key,
            id: c.id,
            type: "manual",
            highlightText: c.highlight_text ?? "",
            position: located !== -1 ? located : c.highlight_start ?? -1,
            clause: "—",
            summary: c.comment_text,
            comment: c,
        });
    }

    rows.sort((a, b) => {
        if (a.position === -1 && b.position === -1) return 0;
        if (a.position === -1) return 1;
        if (b.position === -1) return -1;
        return a.position - b.position;
    });
    return rows;
}

const DISMISSING_ACTIONS = new Set(["dismiss", "reject", "skip"]);

export function statusForAnnotation(a: FindingAnnotation): AnnotationStatus {
    if (a.type === "manual") return "reviewed";
    if (!a.feedback) return "pending";
    return DISMISSING_ACTIONS.has(a.feedback.action) ? "dismissed" : "reviewed";
}

/** "This is fine" per type; null where a blanket confirmation makes no sense. */
export function bulkValidAction(type: AnnotationType): string | null {
    switch (type) {
        case "red_flag":
        case "yellow_flag":
            return "valid";
        case "revision":
            return "accept";
        default:
            return null;
    }
}

/** "Ignore this" per type, using the verb the single-finding widget uses. */
export function bulkDismissAction(type: AnnotationType): string | null {
    switch (type) {
        case "red_flag":
        case "yellow_flag":
            return "dismiss";
        case "revision":
            return "reject";
        case "clarification":
            return "skip";
        default:
            return null;
    }
}

export const SEVERITY_RANK: Record<string, number> = {
    CRITICAL: 0,
    MUST_CHANGE: 0,
    HIGH: 1,
    SHOULD_CHANGE: 1,
    MEDIUM: 2,
    NICE_TO_HAVE: 2,
    LOW: 3,
};

export const ANNOTATION_TYPE_LABEL: Record<AnnotationType, string> = {
    red_flag: "Tanda Bahaya",
    revision: "Saran Revisi",
    clarification: "Klarifikasi",
    yellow_flag: "Peringatan",
    positive: "Temuan Positif",
    manual: "Komentar",
};

export const COMMENT_TYPE_LABEL: Record<string, string> = {
    note: "Catatan",
    revision_suggestion: "Saran Revisi",
    question: "Pertanyaan",
    red_flag: "Tanda Bahaya",
};

export function groupReplies(comments: ManualCommentRow[]): Map<string, ManualCommentRow[]> {
    const map = new Map<string, ManualCommentRow[]>();
    for (const c of comments) {
        if (!c.parent_comment_id) continue;
        const list = map.get(c.parent_comment_id) ?? [];
        list.push(c);
        map.set(c.parent_comment_id, list);
    }
    return map;
}
