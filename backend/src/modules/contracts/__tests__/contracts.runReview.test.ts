import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const mocks = vi.hoisted(() => ({
  callJanusTool: vi.fn(),
  buildReviewContextFor: vi.fn(),
  listPromptRules: vi.fn(),
  projectRevisions: vi.fn(),
}));
vi.mock("../../../lib/janusTools", () => ({ callJanusTool: mocks.callJanusTool }));
vi.mock("../contracts.context", () => ({ buildReviewContextFor: mocks.buildReviewContextFor }));
vi.mock("../../playbook/playbook.service", () => ({ listPromptRules: mocks.listPromptRules }));
vi.mock("../contracts.redline", () => ({ projectRevisions: mocks.projectRevisions }));

import { runReview } from "../contracts.reviews";

const OUTPUT = {
  executive_summary: "ok",
  client_name: "Markas Daging",
  contract_type: "PKS",
  template_used: "t",
  overall_recommendation: "NEEDS_REVISIONS",
  risk_level: "HIGH",
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

const INPUT = { contract_text: "PKS...", client_name: "Markas Daging", document_type: "PKS", project_context: "", review_focus: [] as string[] };
const RULES = [{ rule_number: "RULE 1", title: "Cap", description: "≤ 10x", thresholds: {}, severity: "CRITICAL" }];

describe("runReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildReviewContextFor.mockResolvedValue({ clauseLibraryContext: "CL", pastFeedbackContext: "PF" });
    mocks.projectRevisions.mockResolvedValue({ ok: true, data: { projected: 0, failed: 0, skipped: 0, edits: [] } });
  });

  it("sends Mike's active playbook with the review and stores the result", async () => {
    mocks.listPromptRules.mockResolvedValue(RULES);
    mocks.callJanusTool.mockResolvedValue(JSON.stringify(OUTPUT));
    const { db, calls } = scriptedDb([{ table: "reviews", op: "update", data: null }]);

    await runReview(db, "rev-1", INPUT);

    expect(mocks.callJanusTool).toHaveBeenCalledWith("run_contract_review", expect.objectContaining({
      contract_text: "PKS...",
      clause_library_context: "CL",
      past_feedback_context: "PF",
      playbook_rules: RULES,
    }));
    expect(calls[0].payload).toMatchObject({ status: "ai_reviewed", lifecycle_stage: "ai_review", risk_level: "HIGH" });
    expect(calls[0].filters).toEqual([["eq", "id", "rev-1"]]);
    expect(mocks.projectRevisions).toHaveBeenCalledWith(db, { reviewId: "rev-1" });
  });

  it("refuses to review against an empty playbook and marks the review failed", async () => {
    mocks.listPromptRules.mockResolvedValue([]);
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, calls } = scriptedDb([{ table: "reviews", op: "update", data: null }]);

    await runReview(db, "rev-1", INPUT);

    expect(mocks.callJanusTool).not.toHaveBeenCalled();
    expect(calls[0].payload).toEqual({ status: "failed" });
    warn.mockRestore();
  });
});
