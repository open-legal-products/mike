import { describe, expect, it, vi } from "vitest";

import {
  createCitationRecorder,
  documentCitations,
  tabularCitations,
} from "../citeSources";
import type { TabularCellStore } from "../types";

const SOURCE =
  "[Page 1]\nThe Tenant shall pay rent monthly in advance.\n[Page 2]\nEither party may terminate on 30 days' written notice.";

function setup() {
  const readSourceText = vi.fn(async () => SOURCE);
  const recorder = createCitationRecorder(
    documentCitations({
      docIndex: { "doc-0": { document_id: "document-0", filename: "Lease.pdf" } },
      docStore: new Map(),
      casesByClusterId: new Map(),
      readSourceText,
      getCaseOpinions: async () => [],
    }),
  );
  // Each call's timeline event, in order; record() returns the tool result.
  const events: unknown[] = [];
  const rec = {
    ...recorder,
    record: async (input: unknown) => {
      const { content, event } = await recorder.record(input);
      events.push(event);
      return content;
    },
  };
  return { rec, readSourceText, events };
}

const entry = (ref: number, quote: string, extra: Record<string, unknown> = {}) => ({
  ref,
  doc_id: "doc-0",
  quotes: [{ page: "2", quote }],
  ...extra,
});

describe("cite_sources", () => {
  it("records verified citations in ref order and tells the model to write the answer", async () => {
    const { rec, events } = setup();
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
      next: expect.stringContaining("Do not list the citations"),
    });
    const citations = rec.citations();
    expect(citations.map((c) => c.ref)).toEqual([1, 2]);
    expect(events).toEqual([
      {
        type: "citations_recorded",
        refs: [1, 2],
        sources: [{ name: "Lease.pdf", type: "pdf", ref: 1 }],
        quotes_not_found: 0,
        rejected: 0,
      },
    ]);
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
    const { rec, events } = setup();
    const first = JSON.parse(
      await rec.record({ citations: [entry(1, "The landlord may enter at any time")] }),
    );
    expect(first.quotes_not_found).toEqual([
      { ref: 1, quote: "The landlord may enter at any time" },
    ]);
    expect(first.next).toContain("Call cite_sources again with the same ref");
    expect(events[0]).toMatchObject({ refs: [1], quotes_not_found: 1 });
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
    const { rec, events } = setup();
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
    expect(events).toEqual([
      { type: "citations_recorded", refs: [], sources: [], quotes_not_found: 0, rejected: 3 },
    ]);
  });

  it("flags refs with gaps", async () => {
    const { rec } = setup();
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
    const { rec, readSourceText, events } = setup();
    for (const input of [{}, { citations: [] }, { citations: "[1]" }, null]) {
      expect(JSON.parse(await rec.record(input)).error).toContain(
        "non-empty citations array",
      );
    }
    expect(readSourceText).not.toHaveBeenCalled();
    // The timeline still closes each call's step, as one that recorded nothing.
    expect(events).toEqual(
      Array(4).fill({
        type: "citations_recorded",
        refs: [],
        sources: [],
        quotes_not_found: 0,
        rejected: 0,
      }),
    );
  });

  it("reads a document once per call, and afresh on the next one", async () => {
    const { rec, readSourceText } = setup();
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

describe("cite_sources in a tabular review", () => {
  const store = (): TabularCellStore => ({
    columns: [{ index: 0, name: "Rent" }, { index: 1, name: "Term" }],
    documents: [{ id: "row-a", filename: "Lease A.pdf" }, { id: "row-b", filename: "Lease B.docx" }],
    // Read so far: COL:0 of both rows; COL:1 ROW:1 was read and is empty.
    cells: new Map([
      ["0:row-a", { summary: "Rent is $5,000 per month, payable in advance." }],
      ["0:row-b", { summary: "Rent is $7,500 per month." }],
      ["1:row-b", null],
    ]),
  });
  const record = async (rec: ReturnType<typeof createCitationRecorder>, citations: unknown[]) => {
    const { content, event } = await rec.record({ citations });
    return { result: JSON.parse(content), event };
  };

  it("records cells the model read, checked against their summaries", async () => {
    const rec = createCitationRecorder(tabularCitations(store()));
    const { result, event } = await record(rec, [
      { ref: 1, col_index: 0, row_index: 0, quote: "Rent is $5,000 per month" },
      { ref: 2, col_index: 0, row_index: 1, quote: "Rent is $9,000 per month" },
    ]);

    expect(result.recorded_refs).toEqual([1, 2]);
    expect(result.quotes_not_found).toEqual([{ ref: 2, quote: "Rent is $9,000 per month" }]);
    expect(rec.citations()).toEqual([
      {
        type: "tabular_citation",
        ref: 1,
        col_index: 0,
        row_index: 0,
        col_name: "Rent",
        doc_name: "Lease A.pdf",
        quote: "Rent is $5,000 per month",
        verified: true,
      },
      expect.objectContaining({ ref: 2, doc_name: "Lease B.docx", verified: false }),
    ]);
    expect(event).toEqual({
      type: "citations_recorded",
      refs: [1, 2],
      sources: [
        { name: "Lease A.pdf", type: "pdf", ref: 1 },
        { name: "Lease B.docx", type: "docx", ref: 2 },
      ],
      quotes_not_found: 1,
      rejected: 0,
    });
  });

  it("refuses cells outside the review, unread, or empty", async () => {
    const rec = createCitationRecorder(tabularCitations(store()));
    const { result } = await record(rec, [
      { ref: 1, col_index: 5, row_index: 0, quote: "x" },
      { ref: 2, col_index: 1, row_index: 0, quote: "x" },
      { ref: 3, col_index: 1, row_index: 1, quote: "x" },
      { ref: 4, col_index: 0, quote: "x" },
    ]);

    expect(result.recorded_refs).toEqual([]);
    expect(result.rejected).toEqual([
      { ref: 1, error: "COL:5 ROW:0 is not a cell of this review." },
      { ref: 2, error: "Read COL:1 ROW:0 with read_table_cells before citing it." },
      { ref: 3, error: "COL:1 ROW:1 is empty." },
      { ref: 4, error: expect.stringContaining("col_index and row_index") },
    ]);
  });
});
