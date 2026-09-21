import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const mocks = vi.hoisted(() => ({
  runContractReviewAi: vi.fn(),
  buildReviewContextFor: vi.fn(),
  listPromptRules: vi.fn(),
  projectRevisions: vi.fn(),
}));
vi.mock("../contracts.ai", () => ({ runContractReviewAi: mocks.runContractReviewAi }));
vi.mock("../contracts.context", () => ({ buildReviewContextFor: mocks.buildReviewContextFor }));
vi.mock("../../playbook/playbook.service", () => ({ listPromptRules: mocks.listPromptRules }));
vi.mock("../contracts.redline", () => ({ projectRevisions: mocks.projectRevisions }));

import { executeReview } from "../contracts.reviews";

const OUTPUT = {
  executive_summary: "ok",
  client_name: "Markas Daging",
  contract_type: "PKS",
  template_used: "t",
  overall_recommendation: "ESCALATE_TO_CEO_COO",
  risk_level: "CRITICAL",
  red_flags: [],
  revisions: [],
  clarifications: [],
  financial_review: [],
  missing_clauses: [],
  yellow_flags: [],
  positive_findings: [],
  section_risks: [],
  playbook_compliance: {},
};

const INPUT = { contract_text: "PKS...", client_name: "Markas Daging", document_type: "PKS", project_context: "", review_focus: ["Menyeluruh"] };
const RULES = [{ rule_number: "RULE 1", title: "Cap", description: "≤ 10x", thresholds: {}, severity: "CRITICAL" }];

describe("executeReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.buildReviewContextFor.mockResolvedValue({ clauseLibraryContext: "CL", pastFeedbackContext: "PF" });
    mocks.projectRevisions.mockResolvedValue({ ok: true, data: { projected: 0, failed: 0, skipped: 0, edits: [] } });
  });

  it("stores the result and returns the outcome to the caller", async () => {
    mocks.listPromptRules.mockResolvedValue(RULES);
    mocks.runContractReviewAi.mockResolvedValue(OUTPUT);
    const { db, calls } = scriptedDb([{ table: "reviews", op: "update", data: null }]);

    const result = await executeReview(db, "rev-1", INPUT);

    expect(result).toEqual({
      ok: true,
      data: { review_id: "rev-1", risk_level: "CRITICAL", recommendation: "ESCALATE_TO_CEO_COO", ai_output: OUTPUT },
    });
    expect(calls[0].payload).toMatchObject({ status: "ai_reviewed", lifecycle_stage: "ai_review", risk_level: "CRITICAL" });
    expect(calls[0].filters).toEqual([["eq", "id", "rev-1"]]);
    expect(mocks.projectRevisions).toHaveBeenCalledWith(db, { reviewId: "rev-1" });
  });

  it("returns unavailable and marks the row failed when the playbook is empty", async () => {
    mocks.listPromptRules.mockResolvedValue([]);
    const { db, calls } = scriptedDb([{ table: "reviews", op: "update", data: null }]);

    const result = await executeReview(db, "rev-1", INPUT);

    expect(result).toMatchObject({ ok: false, kind: "unavailable" });
    expect(mocks.runContractReviewAi).not.toHaveBeenCalled();
    expect(calls[0].payload).toEqual({ status: "failed" });
  });

  it("returns an error and marks the row failed when the model output is not a review", async () => {
    mocks.listPromptRules.mockResolvedValue(RULES);
    mocks.runContractReviewAi.mockResolvedValue({ error: "nope" });
    const { db, calls } = scriptedDb([{ table: "reviews", op: "update", data: null }]);

    const result = await executeReview(db, "rev-1", INPUT);

    expect(result).toMatchObject({ ok: false, kind: "error" });
    expect(calls[0].payload).toEqual({ status: "failed" });
  });

  it("returns an error and marks the row failed when the model call throws", async () => {
    mocks.listPromptRules.mockResolvedValue(RULES);
    mocks.runContractReviewAi.mockRejectedValue(new Error("AI usage limit reached"));
    const { db, calls } = scriptedDb([{ table: "reviews", op: "update", data: null }]);

    const result = await executeReview(db, "rev-1", INPUT);

    expect(result).toMatchObject({ ok: false, kind: "error" });
    expect(calls[0].payload).toEqual({ status: "failed" });
  });

  it("does not fail the review when the redline projection fails", async () => {
    mocks.listPromptRules.mockResolvedValue(RULES);
    mocks.runContractReviewAi.mockResolvedValue(OUTPUT);
    mocks.projectRevisions.mockRejectedValue(new Error("docx broken"));
    const { db } = scriptedDb([{ table: "reviews", op: "update", data: null }]);

    const result = await executeReview(db, "rev-1", INPUT);

    expect(result.ok).toBe(true);
  });
});
