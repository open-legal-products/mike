import { describe, expect, it } from "vitest";
import { DEFAULT_DOCX_DIFF_ENGINE, getDocxDiffEngine } from "../docxDiff";

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
});
