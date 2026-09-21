import { describe, expect, it } from "vitest";
import { summarizeReviewOutput } from "../contracts.reviews";
import type { RedFlag, ReviewOutput } from "../contracts.types";

function flag(id: string, severity: RedFlag["severity"]): RedFlag {
  return {
    id,
    severity,
    clause: `Pasal ${id}`,
    title: `Title ${id}`,
    issue: "issue",
    business_impact: "impact",
    action: `Action ${id}`,
    playbook_rule: "RULE 1",
    requires_approval: null,
    highlight_text: `quote ${id}`,
  };
}

const OUTPUT: ReviewOutput = {
  executive_summary: "Ringkasan",
  client_name: "Markas Daging",
  contract_type: "PKS",
  template_used: "t",
  overall_recommendation: "NEEDS_REVISIONS",
  risk_level: "HIGH",
  red_flags: [flag("RF-001", "MEDIUM"), flag("RF-002", "CRITICAL"), flag("RF-003", "HIGH")],
  revisions: [
    {
      id: "REV-001",
      clause: "5",
      original_text: "a",
      suggested_text: "b",
      rationale: "r",
      priority: "MUST_CHANGE",
      from_clause_library: false,
      clause_library_source: null,
    },
  ],
  clarifications: [],
  financial_review: [],
  missing_clauses: [
    { clause_name: "Force Majeure", description: "d", suggested_wording: "w", importance: "HIGH", from_clause_library: false, clause_library_source: null },
  ],
  yellow_flags: [{ item: "x", clause: null, note: "n" }],
  positive_findings: [],
  section_risks: [],
  playbook_compliance: {
    liability_cap: { status: "non_compliant", assessment: "a", clause_reference: "5.2.1(a)", playbook_threshold: "Rp 10jt" },
    payment_terms: { status: "compliant", assessment: "ok" },
    insurance: { status: "needs_attention", assessment: "hmm" },
  },
};

describe("summarizeReviewOutput", () => {
  it("counts every finding type and orders red flags by severity", () => {
    const s = summarizeReviewOutput(OUTPUT);
    expect(s.counts).toEqual({ red_flags: 3, revisions: 1, clarifications: 0, missing_clauses: 1, yellow_flags: 1, positive_findings: 0 });
    expect(s.red_flags.map((f) => f.id)).toEqual(["RF-002", "RF-003", "RF-001"]);
    expect(s.red_flags[0]).toEqual({
      id: "RF-002",
      severity: "CRITICAL",
      clause: "Pasal RF-002",
      title: "Title RF-002",
      action: "Action RF-002",
      playbook_rule: "RULE 1",
      highlight_text: "quote RF-002",
    });
    expect(s.red_flags_omitted).toBe(0);
    expect(s.risk_level).toBe("HIGH");
    expect(s.overall_recommendation).toBe("NEEDS_REVISIONS");
    expect(s.executive_summary).toBe("Ringkasan");
  });

  it("caps the red flags and reports how many were left out", () => {
    const s = summarizeReviewOutput(OUTPUT, { maxFlags: 1 });
    expect(s.red_flags.map((f) => f.id)).toEqual(["RF-002"]);
    expect(s.red_flags_omitted).toBe(2);
  });

  it("lists missing clauses and the playbook rules that are not compliant", () => {
    const s = summarizeReviewOutput(OUTPUT);
    expect(s.missing_clauses).toEqual([{ clause_name: "Force Majeure", importance: "HIGH" }]);
    expect(s.non_compliant_rules).toEqual([
      { rule: "liability_cap", status: "non_compliant", clause_reference: "5.2.1(a)", playbook_threshold: "Rp 10jt" },
      { rule: "insurance", status: "needs_attention", clause_reference: null, playbook_threshold: null },
    ]);
  });

  it("tolerates a sparse output", () => {
    const s = summarizeReviewOutput({ risk_level: "LOW" } as unknown as ReviewOutput);
    expect(s.counts.red_flags).toBe(0);
    expect(s.red_flags).toEqual([]);
    expect(s.non_compliant_rules).toEqual([]);
    expect(s.overall_recommendation).toBeNull();
  });
});
