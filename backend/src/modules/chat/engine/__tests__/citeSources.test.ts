import { describe, expect, it, vi } from "vitest";

import { createCitationRecorder } from "../citeSources";

const SOURCE =
  "[Page 1]\nThe Tenant shall pay rent monthly in advance.\n[Page 2]\nEither party may terminate on 30 days' written notice.";

function recorder() {
  const readSourceText = vi.fn(async () => SOURCE);
  const rec = createCitationRecorder({
    docIndex: { "doc-0": { document_id: "document-0", filename: "Lease.pdf" } },
    docStore: new Map(),
    casesByClusterId: new Map(),
    readSourceText,
    getCaseOpinions: async () => [],
  });
  return { rec, readSourceText };
}

const entry = (ref: number, quote: string, extra: Record<string, unknown> = {}) => ({
  ref,
  doc_id: "doc-0",
  quotes: [{ page: "2", quote }],
  ...extra,
});

describe("cite_sources", () => {
  it("records verified citations in ref order and tells the model to write the answer", async () => {
    const { rec } = recorder();
    const result = JSON.parse(
      await rec.record({
        citations: [
          entry(2, "Either party may terminate on 30 days' written notice"),
          { ...entry(1, "The Tenant shall pay rent monthly in advance"), quotes: [{ page: 1, quote: "The Tenant shall pay rent monthly in advance" }] },
        ],
      }),
    );

    expect(result).toEqual({
      recorded_refs: [1, 2],
      next: expect.stringContaining("Do not write a <CITATIONS> block"),
    });
    const citations = rec.citations();
    expect(citations.map((c) => c.ref)).toEqual([1, 2]);
    expect(citations[1]).toMatchObject({
      type: "citation_data",
      kind: "document",
      doc_id: "doc-0",
      document_id: "document-0",
      filename: "Lease.pdf",
      page: 2,
      verified: true,
    });
  });

  it("reports a quote that is not in its source, and a resent ref replaces it", async () => {
    const { rec } = recorder();
    const first = JSON.parse(
      await rec.record({ citations: [entry(1, "The landlord may enter at any time")] }),
    );
    expect(first.quotes_not_found).toEqual([
      { ref: 1, quote: "The landlord may enter at any time" },
    ]);
    expect(first.next).toContain("Call cite_sources again with the same ref");
    expect(rec.citations()[0]).toMatchObject({ ref: 1, verified: false });

    const second = JSON.parse(
      await rec.record({
        citations: [entry(1, "Either party may terminate on 30 days' written notice")],
      }),
    );
    expect(second.quotes_not_found).toBeUndefined();
    expect(rec.citations()).toHaveLength(1);
    expect(rec.citations()[0]).toMatchObject({ ref: 1, verified: true });
  });

  it("rejects entries it cannot cite and says why, without recording them", async () => {
    const { rec } = recorder();
    const result = JSON.parse(
      await rec.record({
        citations: [
          entry(1, "Either party may terminate on 30 days' written notice", { doc_id: "Lease.pdf" }),
          { ref: 2, doc_id: "doc-9", quotes: [{ quote: "anything" }] },
          { doc_id: "doc-0", quotes: [{ quote: "no ref" }] },
        ],
      }),
    );

    // A filename is not a handle the index knows; neither is an unseen label.
    expect(result.recorded_refs).toEqual([]);
    expect(result.rejected).toEqual([
      { ref: 1, error: expect.stringContaining('"Lease.pdf" is not a document') },
      { ref: 2, error: expect.stringContaining('"doc-9" is not a document') },
      { ref: null, error: expect.stringContaining("integer ref") },
    ]);
    expect(rec.citations()).toEqual([]);
  });

  it("flags refs with gaps", async () => {
    const { rec } = recorder();
    const result = JSON.parse(
      await rec.record({
        citations: [
          entry(1, "Either party may terminate on 30 days' written notice"),
          entry(3, "Either party may terminate on 30 days' written notice"),
        ],
      }),
    );
    expect(result.recorded_refs).toEqual([1, 3]);
    expect(result.next).toContain("Recorded refs have gaps");
  });

  it("asks for a citations array when it gets none", async () => {
    const { rec, readSourceText } = recorder();
    for (const input of [{}, { citations: [] }, { citations: "[1]" }, null]) {
      expect(JSON.parse(await rec.record(input)).error).toContain(
        "non-empty citations array",
      );
    }
    expect(readSourceText).not.toHaveBeenCalled();
  });

  it("reads a document once per call, and afresh on the next one", async () => {
    const { rec, readSourceText } = recorder();
    const quote = "Either party may terminate on 30 days' written notice";
    await rec.record({ citations: [entry(1, quote), entry(2, quote)] });
    expect(readSourceText).toHaveBeenCalledTimes(1);

    // The document was edited since: the next check sees its new text.
    readSourceText.mockResolvedValue("[Page 1]\nThe notice period is now 60 days.");
    const result = JSON.parse(await rec.record({ citations: [entry(1, quote)] }));
    expect(readSourceText).toHaveBeenCalledTimes(2);
    expect(result.quotes_not_found).toEqual([{ ref: 1, quote }]);
  });
});
