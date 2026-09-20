import { describe, expect, it } from "vitest";
import { buildClauseLibraryContext, buildPastFeedbackContext } from "../contracts.service";

describe("buildClauseLibraryContext", () => {
  it("returns an empty string with no clauses", () => {
    expect(buildClauseLibraryContext([])).toBe("");
  });

  it("renders one CLAUSE block per row with N/A for a missing source client", () => {
    const out = buildClauseLibraryContext([
      { title: "Ganti Rugi", wording: "Pihak Kedua ...", source_type: "PKS", source_client_name: null },
      { title: "Force Majeure", wording: "Keadaan kahar ...", source_type: "NDA", source_client_name: "PT X" },
    ]);
    expect(out).toContain("CLAUSE: Ganti Rugi\nAPPROVED WORDING: Pihak Kedua ...\nSOURCE: PKS — N/A\n---");
    expect(out).toContain("SOURCE: NDA — PT X");
  });
});

describe("buildPastFeedbackContext", () => {
  const empty = { clientFeedback: [], docTypeFeedback: [], missedForClient: [], missedForDocType: [] };

  it("returns an empty string when there is no history", () => {
    expect(buildPastFeedbackContext({ clientName: "A", docType: "PKS", ...empty })).toBe("");
  });

  it("ranks common overrides by frequency and keeps the top five", () => {
    const docTypeFeedback = [
      ...Array(3).fill({ finding_type: "red_flag", finding_id: "RF-001", action: "dismiss", rationale: "ok" }),
      ...Array(1).fill({ finding_type: "revision", finding_id: "REV-002", action: "reject", rationale: null }),
      ...["a", "b", "c", "d", "e"].map((id) => ({ finding_type: "yellow_flag", finding_id: id, action: "adjust", rationale: null })),
    ];
    const out = buildPastFeedbackContext({ clientName: "A", docType: "PKS", ...empty, docTypeFeedback });
    expect(out).toContain("COMMON OVERRIDES FOR PKS DOCUMENTS:");
    expect(out.indexOf("red_flag RF-001: dismiss (3x) — ok")).toBeGreaterThan(-1);
    expect(out.match(/^- /gm)?.length).toBe(5);
  });

  it("truncates missed-clause quotes to 150 chars and labels the section per client", () => {
    const out = buildPastFeedbackContext({
      clientName: "PT Y",
      docType: "PKS",
      ...empty,
      missedForClient: [{ highlight_text: "x".repeat(200), suggested_category: null, user_note: "note" }],
    });
    expect(out).toContain("AI MISSED CLAUSES FROM PAST PT Y REVIEWS");
    expect(out).toContain(`"${"x".repeat(150)}" — should have been flagged: note`);
  });
});
