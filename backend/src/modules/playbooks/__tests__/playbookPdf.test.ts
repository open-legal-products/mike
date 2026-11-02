import { describe, expect, it, vi } from "vitest";

const { extractPdfText } = vi.hoisted(() => ({ extractPdfText: vi.fn() }));

vi.mock("../../../lib/pdfText", () => ({ extractPdfText }));

import { extractPlaybookPdfStructure } from "../playbooks.word";

describe("playbook PDF extraction", () => {
  it("cites each gap-separated block as a paragraph without crossing pages", async () => {
    extractPdfText.mockResolvedValue(
      [
        "[Page 1]",
        "Limitation of Liability",
        "",
        "Liability is capped at",
        "  fees paid in the prior 12 months.",
        "\n[Page 2]",
        "Escalate uncapped liability.",
      ].join("\n"),
    );

    const structure = await extractPlaybookPdfStructure(Buffer.from("%PDF"));

    expect(structure.format).toBe("pdf");
    expect(structure.sources.map((source) => source.text)).toEqual([
      "Limitation of Liability",
      "Liability is capped at fees paid in the prior 12 months.",
      "Escalate uncapped liability.",
    ]);
    expect(structure.text).toBe(
      "[P1] Limitation of Liability\n\n[P2] Liability is capped at fees paid in the prior 12 months.\n\n[P3] Escalate uncapped liability.",
    );
  });

  it("returns no text for a PDF without a text layer", async () => {
    extractPdfText.mockResolvedValue("[Page 1]\n\n\n[Page 2]\n");

    const structure = await extractPlaybookPdfStructure(Buffer.from("%PDF"));

    expect(structure.text).toBe("");
    expect(structure.sources).toEqual([]);
  });
});
