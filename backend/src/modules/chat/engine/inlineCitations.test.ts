import { describe, expect, it } from "vitest";
import {
  annotatePassages,
  createInlineCitationStream,
  inlineLocator,
  parseCitationTag,
  plainReference,
  withoutCitationMarkup,
  rememberReadText,
  resolveInlineCitations,
  rewriteInlineCitations,
  segmentPassages,
  sourceExists,
  spreadsheetCellValue,
} from "./inlineCitations";
import { withPriorCitationTags } from "./contextBuilders";
import { assessCitationHealth } from "./citationHealth";

const PDF = `[Page 1]
COMMERCIAL LEASE

1. TERM
1.1 The term is ten years starting on 1 April 2025 and ending on
31 March 2035 (the "Term").
1.2 The Tenant may not hold over.

[Page 2]
2. RENT
2.1 The initial annual rent is £186,000.`;

const SHEET = `## Sheet: Rent schedule

| Row | A | B |
| --- | --- | --- |
| 1 | Period | Quarterly (£) |
| 2 | Years 2-5 | 46,500 |
| 3 | Total ⟨merged A3:B3⟩ |  |`;

describe("PDF passage locations", () => {
  it.each([
    "[OCR notice]\n[Page 1]\n",
    "[Page 1]\n[Page 3]\n",
    "[Page 1]\n[Page 1 form fields]\n",
    "[Page 1]\n[Name: Tenant]\n\n",
  ])("omits the offset when extracted text cannot establish a viewer position", async prefix => {
    const text = prefix + "Rent is due.";
    const id = segmentPassages(text).at(-1)!.id;
    const { entries } = rewriteInlineCitations(`[[doc-0 ${id}]]`, 50);
    const { citations } = await resolveInlineCitations(entries, async () => text, { isPdf: () => true });
    expect(citations[0].quotes![0].verification).toBeUndefined();
  });
});

describe("segmentPassages", () => {
  it("cuts at clause starts and blank lines, keeps wrapped lines together, and records pages", () => {
    const passages = segmentPassages(PDF);
    expect(passages.map((p) => [p.id, p.page, p.text.split("\n")[0]])).toEqual([
      [1, 1, "COMMERCIAL LEASE"],
      [2, 1, "1. TERM"],
      [3, 1, "1.1 The term is ten years starting on 1 April 2025 and ending on"],
      [4, 1, "1.2 The Tenant may not hold over."],
      [5, 2, "2. RENT"],
      [6, 2, "2.1 The initial annual rent is £186,000."],
    ]);
    // A wrapped line belongs to its clause.
    expect(passages[2].text).toContain('31 March 2035 (the "Term").');
    // Offsets point into the original text.
    for (const p of passages) expect(PDF.slice(p.start, p.end)).toBe(p.text);
  });

  it("is deterministic and treats text without page markers as one unpaged body", () => {
    const text = "First paragraph.\n\nSecond paragraph.";
    expect(segmentPassages(text)).toEqual(segmentPassages(text));
    expect(segmentPassages(text).map((p) => [p.page, p.text])).toEqual([
      [null, "First paragraph."],
      [null, "Second paragraph."],
    ]);
  });

  it("cuts a long paragraph at sentence ends", () => {
    const sentence = "The Tenant shall keep the interior of the Premises in good repair and condition at all times. ";
    const passages = segmentPassages(sentence.repeat(20).trim());
    expect(passages.length).toBeGreaterThan(1);
    expect(passages.every((p) => p.text.length <= 700)).toBe(true);
    expect(passages.every((p) => p.text.endsWith("."))).toBe(true);
  });
});

describe("annotatePassages", () => {
  it("prefixes each passage with its id and leaves the text otherwise unchanged", () => {
    const annotated = annotatePassages(PDF);
    expect(annotated).toContain("[Page 1]\n{1}COMMERCIAL LEASE");
    expect(annotated).toContain("{6}2.1 The initial annual rent");
    expect(annotated.replace(/\{\d+\}/g, "")).toBe(PDF);
  });

  it("leaves spreadsheets alone: cells are their own locators", () => {
    expect(annotatePassages(SHEET)).toBe(SHEET);
  });
});

describe("parseCitationTag", () => {
  it.each([
    ["doc-0 12", [{ kind: "passages", doc: "doc-0", ranges: [[12, 12]] }]],
    ["doc-0 12-13", [{ kind: "passages", doc: "doc-0", ranges: [[12, 13]] }]],
    ["doc-0 12, 15", [{ kind: "passages", doc: "doc-0", ranges: [[12, 12], [15, 15]] }]],
    ['doc-0 12 "nine months"', [{ kind: "passages", doc: "doc-0", ranges: [[12, 12]], quote: "nine months" }]],
    ['doc-0 "exact words"', [{ kind: "quote", doc: "doc-0", quote: "exact words" }]],
    ["doc-2 Rent schedule!d4", [{ kind: "cell", doc: "doc-2", sheet: "Rent schedule", cell: "D4" }]],
    ["doc-2 'Q1; Q2'!B7:C9", [{ kind: "cell", doc: "doc-2", sheet: "Q1; Q2", cell: "B7:C9" }]],
    ['doc-2 "Rent schedule"!D4', [{ kind: "cell", doc: "doc-2", sheet: "Rent schedule", cell: "D4" }]],
    ['case-1 "The court called it "final" and affirmed."', [{ kind: "case", clusterId: 1, quote: 'The court called it "final" and affirmed.' }]],
    ['case-1 held "final"', null],
    ['doc-0 3 "unclosed', null],
    ["doc-0 12; doc-1 4", [
      { kind: "passages", doc: "doc-0", ranges: [[12, 12]] },
      { kind: "passages", doc: "doc-1", ranges: [[4, 4]] },
    ]],
    ['case-123 "exact opinion text"', [{ kind: "case", clusterId: 123, quote: "exact opinion text" }]],
    ["doc-0", null],
    ["PAGE_BREAK", null],
    ["Clause 4", null],
  ])("%s", (inner, expected) => {
    expect(parseCitationTag(inner)).toEqual(expected);
  });

  it("keeps a semicolon inside a quote", () => {
    expect(parseCitationTag('doc-0 3 "rent; and service charge"')).toEqual([
      { kind: "passages", doc: "doc-0", ranges: [[3, 3]], quote: "rent; and service charge" },
    ]);
  });
});

describe("createInlineCitationStream", () => {
  const streamAll = (chunks: string[]) => {
    const stream = createInlineCitationStream({ maxCitations: 50 });
    const out = chunks.map((c) => stream.push(c)).join("") + stream.flush();
    return { out, stream };
  };

  it("rewrites tags split across any delta boundary", () => {
    const text = "Rent is £186,000 [[doc-0 6]] and the term is ten years [[doc-0 3; doc-1 2]].";
    const expected = "Rent is £186,000 [1] and the term is ten years [2][3].";
    for (let size = 1; size <= 9; size++) {
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
      expect(streamAll(chunks).out).toBe(expected);
    }
  });

  it("passes other double-bracket text through", () => {
    expect(streamAll(["See [[PAGE_BREAK]] and [[a link]]."]).out).toBe("See [[PAGE_BREAK]] and [[a link]].");
  });

  it("drops a citation tag it cannot read, and still cites from an unfinished one at the end", () => {
    const { out, stream } = streamAll(["A [[doc-0 x!]] B [[doc-0 4"]);
    expect(out).toBe("A B [1]");
    expect(stream.malformedCount()).toBe(2);
  });

  it("releases an unclosed [[ that is not a tag once it is too long to be one", () => {
    const long = `[[${"x".repeat(900)}`;
    expect(streamAll([long, " end"]).out).toBe(`${long} end`);
  });

  it("stops numbering at the citation cap", () => {
    const stream = createInlineCitationStream({ maxCitations: 2 });
    const out = stream.push("[[doc-0 1]][[doc-0 2]][[doc-0 3]][[doc-0 1]]") + stream.flush();
    expect(out).toBe("[1][2][1]");
    expect(stream.entries()).toHaveLength(2);
  });

  it("gives no marker to a passage or cell missing from the text that was read", () => {
    const turn = {};
    rememberReadText(turn, "doc-0", PDF);
    rememberReadText(turn, "doc-2", SHEET);
    const stream = createInlineCitationStream({
      maxCitations: 50,
      exists: (source) => sourceExists(turn, source),
    });
    const out =
      stream.push("a [[doc-0 6]] b [[doc-0 7]] c [[doc-2 Rent schedule!B2]] d [[doc-2 Rent schedule!Z9]] e [[doc-9 1]]") +
      stream.flush();
    // doc-9 was not read this turn, so it is resolved at the end instead.
    // A tag that gets no marker takes the space before it too.
    expect(out).toBe("a [1] b c [2] d e [3]");
    expect(stream.missingCount()).toBe(2);
  });
});

describe("spreadsheetCellValue", () => {
  it("reads a cell by sheet and A1 address, and the anchor of a merged range", () => {
    expect(spreadsheetCellValue(SHEET, "Rent schedule", "B2")).toBe("46,500");
    expect(spreadsheetCellValue(SHEET, "rent schedule", "A3:B3")).toBe("Total");
    expect(spreadsheetCellValue(SHEET, "Rent schedule", "C2")).toBeNull();
    expect(spreadsheetCellValue(SHEET, "Other", "B2")).toBeNull();
  });
});

describe("resolveInlineCitations", () => {
  const read = async (doc: string) => (doc === "doc-0" ? PDF : doc === "doc-2" ? SHEET : "");

  it("turns passages, quotes, cells and cases into raw citations", async () => {
    const { entries } = rewriteInlineCitations(
      '[[doc-0 3]] [[doc-0 4-6]] [[doc-0 2 "TERM"]] [[doc-0 "annual rent is £186,000"]] [[doc-2 Rent schedule!B2]] [[case-77 "held"]]',
      50,
    );
    const { citations, unresolved } = await resolveInlineCitations(entries, read);
    expect(unresolved).toBe(0);
    expect(citations[0]).toMatchObject({ ref: 1, doc_id: "doc-0", quotes: [{ page: 1 }] });
    expect((citations[0].quotes as { quote: string }[])[0].quote).toMatch(/^1\.1 The term is ten years/);
    // A range across a page break is one quote per page.
    expect((citations[1].quotes as { page: number }[]).map((q) => q.page)).toEqual([1, 2]);
    expect(citations[2]).toMatchObject({ quotes: [{ page: 1, quote: "TERM" }] });
    expect(citations[3]).toMatchObject({ quotes: [{ page: 2, quote: "annual rent is £186,000" }] });
    expect(citations[4]).toMatchObject({ quotes: [{ sheet: "Rent schedule", cell: "B2", quote: "46,500" }] });
    expect(citations[5]).toMatchObject({ cluster_id: 77, quotes: [{ quote: "held" }] });
  });

  it("leaves out and counts a passage or cell that does not exist", async () => {
    const { entries } = rewriteInlineCitations("[[doc-0 99]] [[doc-2 Rent schedule!Z9]] [[doc-0 2]]", 50);
    const { citations, unresolved } = await resolveInlineCitations(entries, read);
    expect(citations.map((c) => c.ref)).toEqual([3]);
    expect(unresolved).toBe(2);
  });

  it("records a locator for passages and cells", () => {
    expect(inlineLocator({ kind: "passages", doc: "doc-0", ranges: [[3, 3], [5, 7]] })).toBe("3, 5-7");
    expect(inlineLocator({ kind: "cell", doc: "doc-2", sheet: "S", cell: "B2" })).toBe("S!B2");
    expect(inlineLocator({ kind: "quote", doc: "doc-0", quote: "q" })).toBeNull();
  });
});

describe("withPriorCitationTags", () => {
  it("shows an earlier answer's markers as the tags they stood for, under today's labels", () => {
    const stored = [
      { ref: 1, document_id: "uuid-a", version_id: "v1", inline_locator: "12-13", quotes: [{ quote: "x" }] },
      { ref: 2, document_id: "uuid-a", quotes: [{ quote: 'the "Term" ends' }] },
      { ref: 3, document_id: "uuid-gone", inline_locator: "4" },
      { ref: 4, kind: "case", cluster_id: 9, quotes: [{ quote: "held" }] },
    ];
    const slugs = new Map([["uuid-a", "doc-3"]]);
    expect(withPriorCitationTags("A [1]. B [2]. C [3]. D [4].", stored, slugs, new Map([["uuid-a", "v1"]]))).toBe(
      `A [[doc-3 12-13]]. B [[doc-3 "the 'Term' ends"]]. C . D [[case-9 "held"]].`,
    );
    // After an edit the numbering may name other text: replay the quote.
    expect(withPriorCitationTags("A [1].", stored, slugs, new Map([["uuid-a", "v2"]]))).toBe(
      `A [[doc-3 "x"]].`,
    );
  });
});

describe("assessCitationHealth", () => {
  it("counts markers with nothing behind them, unused citations and gaps", () => {
    const health = assessCitationHealth({
      format: "cite_sources",
      outcome: "completed",
      surface: "chat",
      visibleText: "A [1]. B [2]. C [4].",
      citations: [
        { ref: 1, quotes: [{ verification: { verified: true } }] },
        { ref: 3, quotes: [{ verification: { verified: false } }] },
      ],
    });
    expect(health).toMatchObject({
      markers: 3,
      citations: 2,
      danglingMarkers: 2,
      unusedCitations: 1,
      markersWithoutCitations: false,
      refGaps: true,
      quotes: 2,
      unverifiedQuotes: 1,
    });
  });
});

describe("withoutCitationMarkup", () => {
  const turn = {};
  rememberReadText(turn, "doc-0", PDF);
  const reference = (source: Parameters<typeof plainReference>[1]) =>
    plainReference(turn, source, { filenameOf: (doc) => (doc === "doc-0" ? "Lease.pdf" : undefined) });

  it("removes labels copied from the text read, and turns tags into plain references", () => {
    expect(withoutCitationMarkup(turn, "{6}2.1 The initial annual rent is £186,000.", reference)).toBe(
      "2.1 The initial annual rent is £186,000.",
    );
    expect(withoutCitationMarkup(turn, "Rent is £186,000 [[doc-0 6]]. Term [[doc-0 3; doc-9 1]].", reference)).toBe(
      "Rent is £186,000 (Lease.pdf, p. 2). Term (Lease.pdf, p. 1).",
    );
    expect(withoutCitationMarkup(turn, "Unknown [[doc-9 4]]. Broken [[doc-0 4", reference)).toBe(
      "Unknown. Broken (Lease.pdf, p. 1)",
    );
    // Prose after a tag left open is kept; only the citation is replaced.
    expect(withoutCitationMarkup(turn, "Rent is due [[doc-0 4 and interest accrues daily.", reference)).toBe(
      "Rent is due (Lease.pdf, p. 1) and interest accrues daily.",
    );
  });

  it("leaves everything else alone: LaTeX, placeholders, other brackets", () => {
    for (const text of [
      "$$\\frac{1}{2}$$ and {3} items",
      "Dear {1}, please sign by {2}.",
      "See [[PAGE_BREAK]] and [[Clause 4]].",
      "Plain text with  two spaces .",
    ]) {
      expect(withoutCitationMarkup(turn, text, reference)).toBe(text);
    }
  });
});
