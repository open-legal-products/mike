import { describe, expect, it, vi } from "vitest";

import {
  CITE_DOCUMENTS_TOOL,
  createCitationRecorder,
  documentCitations,
  missingCitationsInstruction,
  tabularCitations,
  unrecordedMarkerRefs,
} from "../citeSources";
import { loadToolInputChecker } from "../../../../lib/llm/toolInputValidation";
import { citationReminder } from "../tools/documentOps";
import { renderTableCells } from "../tools/tableCells";
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

  it("accepts the PDF read reminder example under enforced tool validation", async () => {
    const reminder = citationReminder("doc-0", "Lease.pdf", "Lease.pdf");
    const example = reminder.match(/Use this citation object shape: (\{[^\n]+\})\./)?.[1];
    expect(example).toBeDefined();
    const checker = await loadToolInputChecker("enforce");
    const tool = CITE_DOCUMENTS_TOOL.function;
    const check = checker(tool.name, tool.parameters);
    expect(check?.({ citations: [JSON.parse(example!)] }).success).toBe(true);
  });

  it("refuses numbers that cannot be positive integer answer markers", async () => {
    const { rec, readSourceText } = setup();
    const result = JSON.parse(await rec.record({
      citations: [0, -1, 1.5, 2 ** 53].map(ref => entry(ref, "Tenant")),
    }));
    expect(result.recorded_refs).toEqual([]);
    expect(result.rejected).toHaveLength(4);
    expect(readSourceText).not.toHaveBeenCalled();
  });

  it("keeps distinct identities with the same filename and canonicalizes upload aliases", async () => {
    const doc = { filename: "Lease.pdf", file_type: "pdf", storage_path: "fixture" };
    const index = {
      "doc-0": { document_id: "lease", filename: doc.filename, version_id: "old" },
      "doc-1": { document_id: "lease", filename: doc.filename, version_id: "new" },
      "doc-2": { document_id: "other", filename: doc.filename, version_id: "third" },
    };
    const docs = new Map(Object.keys(index).map(label => [label, doc]));
    const recorder = createCitationRecorder(documentCitations({
      docIndex: index, docStore: docs, casesByClusterId: new Map(),
      readSourceText: async () => SOURCE, getCaseOpinions: async () => [],
    }));
    const rows = ["doc-0", "doc-0", "doc-1", "other", doc.filename].map((doc_id, i) =>
      entry(i + 1, "The Tenant shall pay rent monthly in advance.", { doc_id }));
    const { event } = await recorder.record({ citations: rows });
    expect(event.sources.map(s => s.ref)).toEqual([1, 3, 4]);
    expect(event.rejected).toBe(1); // The shared filename cannot select a document.
    expect(recorder.citations()[3]).toMatchObject({
      doc_id: "doc-2", document: { document_id: "other", version_id: "third" },
    });

    const replacement = await recorder.record({ citations: [rows[0], { ...rows[3], ref: 1 }] });
    expect(replacement.event.sources).toHaveLength(1);
    expect(recorder.citations()[0].document_id).toBe("other");
  });

  it("removes an abandoned ref, reuses its number and ignores malformed removal calls", async () => {
    const { rec, events } = setup();
    const row = entry(1, "The Tenant shall pay rent monthly in advance.");
    await rec.record({ citations: [row, { ...row, ref: 2 }] });
    const invalid = await rec.record({ citations: [{ ...row, ref: 3 }], drop_refs: [1, "2"] });
    expect(JSON.parse(invalid).error).toBeDefined();
    expect(rec.citations().map(c => c.ref)).toEqual([1, 2]);
    const result = JSON.parse(await rec.record({ citations: [], drop_refs: [2] }));
    expect(result.recorded_refs).toEqual([1]);
    expect(events.at(-1)).toMatchObject({ removed_refs: [2] });
    await rec.record({ citations: [{ ...row, ref: 2 }] });
    expect(rec.citations().map(c => c.ref)).toEqual([1, 2]);
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

  it("supports withdrawal and rejects unsafe ref numbers for table cells", async () => {
    const rec = createCitationRecorder(tabularCitations(store()));
    const cell = { ref: 1, col_index: 0, row_index: 0, quote: "Rent is $5,000 per month" };
    const { result } = await record(rec, [cell, { ...cell, ref: 2 ** 53 }]);
    expect(result.recorded_refs).toEqual([1]);
    expect(result.rejected).toHaveLength(1);
    const { event } = await rec.record({ citations: [], drop_refs: [1] });
    expect(event).toMatchObject({ refs: [], removed_refs: [1] });
    expect(rec.citations()).toEqual([]);
  });

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

  it("verifies against the column read even when its stored index differs from COL:n", async () => {
    const review = store();
    review.columns = [{ index: 1, name: "Rent" }, { index: 4, name: "Term" }];
    review.cells = new Map([
      ["1:row-a", { summary: "Monthly rent is five thousand dollars." }],
      ["4:row-a", { summary: "The lease expires in June." }],
    ]);
    const quote = "The lease expires in June.";
    const read = await renderTableCells(review, [1], [0]);
    expect(read.content).toContain('[COL:1 "Term" | ROW:0 "Lease A.pdf"]\nSummary: ' + quote);
    const rec = createCitationRecorder(tabularCitations(review));
    const { result } = await record(rec, [{ ref: 1, col_index: 1, row_index: 0, quote }]);
    expect(result.quotes_not_found).toBeUndefined();
    expect(rec.citations()).toMatchObject([{ col_index: 1, col_name: "Term", verified: true }]);
    review.cells.delete("4:row-a");
    const retry = await record(rec, [{ ref: 2, col_index: 1, row_index: 0, quote }]);
    expect(retry.result.rejected).toMatchObject([{ ref: 2 }]);
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

describe("unrecordedMarkerRefs", () => {
  it("lists each marker ref without a recorded citation once, in order", () => {
    expect(
      unrecordedMarkerRefs("A [3]. B [1, 2]. C [3] and [2,4].", [1]),
    ).toEqual([2, 3, 4]);
  });

  it("finds nothing when every marker is recorded, or there are none", () => {
    expect(unrecordedMarkerRefs("A [1]. B [2].", [1, 2])).toEqual([]);
    expect(unrecordedMarkerRefs("No markers here.", [])).toEqual([]);
  });

  it("does not read a number past the citation cap, or a non-number, as a ref", () => {
    expect(unrecordedMarkerRefs("Decided in [2024]; see [0] and [a].", [])).toEqual([]);
  });
});

describe("missingCitationsInstruction", () => {
  it("names the markers and asks only for the tool call", () => {
    expect(missingCitationsInstruction([2])).toContain("uses [2], but no citation was recorded for that marker. Call cite_sources now");
    expect(missingCitationsInstruction([2, 3])).toContain("uses [2], [3], but no citation was recorded for those markers.");
    expect(missingCitationsInstruction([2])).toContain("do not write anything else");
  });
});
