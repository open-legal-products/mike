import { describe, expect, it } from "vitest";
import { buildAnnotations, bulkDismissAction, bulkValidAction, groupReplies, locateQuote, statusForAnnotation } from "./findingAnnotations";
import type { ManualCommentRow, ReviewFeedbackRow, ReviewOutput } from "./reviewTypes";

const OUTPUT = {
    executive_summary: "x",
    client_name: "c",
    contract_type: "PKS",
    template_used: "t",
    overall_recommendation: "NEEDS_REVISIONS",
    risk_level: "HIGH",
    red_flags: [{ id: "RF-001", severity: "CRITICAL", clause: "Pasal 9", title: "Cap terlalu tinggi", issue: "i", business_impact: "b", action: "a", playbook_rule: "RULE 1", requires_approval: null, highlight_text: "liability shall not exceed" }],
    revisions: [{ id: "REV-001", clause: "Pasal 2", original_text: "Net 60", suggested_text: "Net 30", rationale: "r", priority: "MUST_CHANGE", from_clause_library: false, clause_library_source: null }],
    clarifications: [{ id: "CLR-001", question: "Siapa PIC?", clause: "Pasal 4", assign_to: "BD", highlight_text: "nowhere in text" }],
    financial_review: [],
    missing_clauses: [],
    yellow_flags: [{ item: "Auto-renew", clause: null, note: "n", highlight_text: "AUTOMATICALLY RENEW" }],
    positive_findings: [{ clause: "Pasal 11", finding: "Hukum Indonesia", highlight_text: "governed by the laws of Indonesia" }],
    section_risks: [],
    playbook_compliance: {},
} as unknown as ReviewOutput;

const TEXT = "This Agreement shall automatically renew. Payment Net 60 days. Dash liability shall not exceed 10x. It is governed by the laws of Indonesia.";

function fb(type: string, id: string, action: string): ReviewFeedbackRow {
    return { id: `${type}-${id}`, review_id: "r1", user_id: "u1", finding_type: type, finding_id: id, action, original_severity: null, adjusted_severity: null, original_text: null, edited_text: null, rationale: null, created_at: "2026-09-20T00:00:00Z" } as ReviewFeedbackRow;
}

function comment(partial: Partial<ManualCommentRow>): ManualCommentRow {
    return { id: "c1", review_id: "r1", user_id: "u1", user_name: "aditya", comment_type: "note", highlight_text: null, highlight_start: null, highlight_end: null, comment_text: "hi", suggested_text: null, parent_comment_id: null, created_at: "2026-09-20T00:00:00Z", ...partial } as ManualCommentRow;
}

describe("locateQuote", () => {
    it("matches exact, then case-insensitive, else -1", () => {
        expect(locateQuote(TEXT, "Net 60")).toBe(TEXT.indexOf("Net 60"));
        expect(locateQuote(TEXT, "AUTOMATICALLY RENEW")).toBe(TEXT.toLowerCase().indexOf("automatically renew"));
        expect(locateQuote(TEXT, "nope")).toBe(-1);
        expect(locateQuote(null, "Net 60")).toBe(-1);
    });
});

describe("buildAnnotations", () => {
    it("emits one row per finding and root comment, keyed like review_feedback, sorted by document position", () => {
        const feedbackMap = new Map([["revision:REV-001", fb("revision", "REV-001", "accept")]]);
        const comments = [
            comment({ id: "c1", highlight_text: "governed by the laws" }),
            comment({ id: "c2", parent_comment_id: "c1", comment_text: "reply" }),
        ];
        const rows = buildAnnotations({ output: OUTPUT, comments, feedbackMap, contractText: TEXT });
        expect(rows.map((r) => r.key)).toEqual([
            "yellow_flag:YF-0",
            "revision:REV-001",
            "red_flag:RF-001",
            "positive:PF-0",
            "manual:c1",
            "clarification:CLR-001", // unlocated quote sorts last
        ]);
        expect(rows.find((r) => r.key === "revision:REV-001")?.feedback?.action).toBe("accept");
        expect(rows.find((r) => r.key === "manual:c1")?.comment?.id).toBe("c1");
        expect(rows.find((r) => r.type === "red_flag")?.playbookRule).toBe("RULE 1");
    });

    it("falls back to the stored offset for comments whose quote no longer matches", () => {
        const rows = buildAnnotations({ output: OUTPUT, comments: [comment({ highlight_text: "gone", highlight_start: 3 })], feedbackMap: new Map(), contractText: TEXT });
        expect(rows.find((r) => r.type === "manual")?.position).toBe(3);
    });
});

describe("statusForAnnotation + bulk verbs", () => {
    it("derives pending / reviewed / dismissed", () => {
        const [row] = buildAnnotations({ output: OUTPUT, comments: [], feedbackMap: new Map(), contractText: null }).filter((r) => r.type === "red_flag");
        expect(statusForAnnotation(row)).toBe("pending");
        expect(statusForAnnotation({ ...row, feedback: fb("red_flag", "RF-001", "valid") })).toBe("reviewed");
        expect(statusForAnnotation({ ...row, feedback: fb("red_flag", "RF-001", "dismiss") })).toBe("dismissed");
        expect(statusForAnnotation({ ...row, type: "manual" })).toBe("reviewed");
    });

    it("maps bulk verbs per type and refuses where a blanket action makes no sense", () => {
        expect(bulkValidAction("red_flag")).toBe("valid");
        expect(bulkValidAction("revision")).toBe("accept");
        expect(bulkValidAction("yellow_flag")).toBe("valid");
        expect(bulkValidAction("clarification")).toBeNull();
        expect(bulkValidAction("positive")).toBeNull();
        expect(bulkDismissAction("revision")).toBe("reject");
        expect(bulkDismissAction("clarification")).toBe("skip");
        expect(bulkDismissAction("manual")).toBeNull();
    });
});

describe("groupReplies", () => {
    it("groups by parent id in order", () => {
        const map = groupReplies([comment({ id: "a" }), comment({ id: "b", parent_comment_id: "a" }), comment({ id: "c", parent_comment_id: "a" })]);
        expect(map.get("a")?.map((c) => c.id)).toEqual(["b", "c"]);
        expect(map.has("b")).toBe(false);
    });
});
