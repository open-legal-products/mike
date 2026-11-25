import { describe, expect, it } from "vitest";
import { DEFAULT_DOCX_DIFF_ENGINE, getDocxDiffEngine, summarizeDocxDiff } from "../docxDiff";

describe("docx diff engine registry", () => {
  it("uses Docxodus when nothing is configured", () => {
    expect(DEFAULT_DOCX_DIFF_ENGINE).toBe("docxodus");
    expect(getDocxDiffEngine(undefined).id).toBe("docxodus");
    expect(getDocxDiffEngine("").id).toBe("docxodus");
    expect(getDocxDiffEngine("  ").id).toBe("docxodus");
  });

  it("accepts the configured name in any case", () => {
    expect(getDocxDiffEngine(" Docxodus ").id).toBe("docxodus");
  });

  it("fails loudly on an unknown engine rather than comparing with another one", () => {
    expect(() => getDocxDiffEngine("wordcompare")).toThrow(/Unknown DOCX_DIFF_ENGINE "wordcompare"\. Available: docxodus\./);
  });

  it("counts revisions by kind", () => {
    expect(summarizeDocxDiff([
      { kind: "insert", text: "a", wordIds: ["1"] },
      { kind: "insert", text: "b", wordIds: ["2"] },
      { kind: "delete", text: "c", wordIds: ["3"] },
      { kind: "move", text: "d", wordIds: ["4", "5"] },
      { kind: "format", text: "", wordIds: ["6"] },
      { kind: "structure", text: "", wordIds: ["7"] },
    ])).toEqual({ insertions: 2, deletions: 1, moves: 1, formatChanges: 1, structuralChanges: 1, total: 6 });
    expect(summarizeDocxDiff([]).total).toBe(0);
  });
});
