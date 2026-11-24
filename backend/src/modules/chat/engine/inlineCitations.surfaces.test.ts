/**
 * Inline citations beyond web chat: a document edited after it was read,
 * the Word add-in's active document, and tabular review cells.
 */
import { describe, expect, it } from "vitest";
import {
  alignPassages,
  createInlineCitationStream,
  latestReadIndex,
  locatableQuote,
  parseCitationTag,
  rememberReadText,
  resolveInlineCitations,
  resolveReadCitations,
  resolveTableCitations,
  rewriteInlineCitations,
  segmentPassages,
  stripCitationMarkers,
  tableSourceExists,
  type TableCells,
} from "./inlineCitations";
import { buildWordChatSystemPrompt } from "./wordPrompt";
import { buildTabularMessages } from "../../tabular/tabular.chats";

const BEFORE = `[Page 1]
9. ASSIGNMENT
9.1 The Tenant shall not assign the whole of this Lease without consent.

10. BREAK CLAUSE
10.1 The Tenant may terminate this Lease on 31 March 2030 by giving not less than nine months' written notice.
10.2 A notice is only effective if all rent is paid.`;

// The edit inserts a clause before the break clause and changes 10.1.
const AFTER = `[Page 1]
9. ASSIGNMENT
9.1 The Tenant shall not assign the whole of this Lease without consent.
9.2 The Tenant shall not underlet part only of the Premises.

10. BREAK CLAUSE
10.1 The Tenant may terminate this Lease on 31 March 2030 by giving not less than twelve months' written notice.
10.2 A notice is only effective if all rent is paid.`;

const idIn = (text: string, words: string) =>
  segmentPassages(text).find((p) => p.text.includes(words))!.id;

describe("a document edited after the model read it", () => {
  it("aligns unchanged passages by text; a changed passage has no counterpart", () => {
    const map = alignPassages(segmentPassages(BEFORE), segmentPassages(AFTER));
    expect(map.get(idIn(BEFORE, "all rent is paid"))!.text).toContain("all rent is paid");
    // "nine" became "twelve": the new wording is not what the model read.
    expect(map.has(idIn(BEFORE, "nine months"))).toBe(false);
  });

  it("resolves a tag to the passage the model was shown, where it is now", async () => {
    const turn = {};
    rememberReadText(turn, "doc-0", BEFORE);
    const rentId = idIn(BEFORE, "all rent is paid");
    // The edit inserted a clause above it: its number now names another passage.
    expect(segmentPassages(AFTER)[rentId - 1].text).not.toContain("all rent is paid");
    const { entries } = rewriteInlineCitations(`Condition [[doc-0 ${rentId}]].`, 50);
    const { citations, unresolved } = await resolveInlineCitations(entries, async () => AFTER, { turn });
    expect(unresolved).toBe(0);
    expect((citations[0].quotes as { quote: string }[])[0].quote).toContain("all rent is paid");
  });

  it("never offers changed wording as the evidence: it keeps what the model read", async () => {
    const turn = {};
    rememberReadText(turn, "doc-0", BEFORE);
    const { entries } = rewriteInlineCitations(`Notice [[doc-0 ${idIn(BEFORE, "nine months")}]].`, 50);
    const { citations } = await resolveInlineCitations(entries, async () => AFTER, { turn });
    // Quoted as read; verification against the edited text then flags it.
    expect((citations[0].quotes as { quote: string }[])[0].quote).toContain("nine months");
  });

  it("resolves each tag against the read it was written after", async () => {
    const turn = {};
    const stream = createInlineCitationStream({
      maxCitations: 50,
      readOf: source => "doc" in source ? latestReadIndex(turn, source.doc) : undefined,
    });
    const passage = idIn(BEFORE, "all rent is paid");
    expect(idIn(AFTER, "twelve months")).toBe(passage);
    const tag = `[[doc-0 ${passage}]]`;
    rememberReadText(turn, "doc-0", BEFORE);
    expect(stream.push(tag)).toBe("[1]");
    rememberReadText(turn, "doc-0", AFTER);
    expect(stream.push(tag)).toBe("[2]");
    rememberReadText(turn, "doc-0", AFTER);
    expect(stream.push(tag)).toBe("[2]");
    stream.flush();

    const entries = stream.entries();
    const expected = [
      { ref: 1, quotes: [{ quote: expect.stringContaining("all rent is paid") }] },
      { ref: 2, quotes: [{ quote: expect.stringContaining("twelve months") }] },
    ];
    expect(resolveReadCitations(turn, entries)).toMatchObject(expected);
    const { citations } = await resolveInlineCitations(entries, async () => AFTER, { turn });
    expect(citations).toMatchObject(expected);
  });

  it("does not clip a range whose end does not exist", async () => {
    const { entries } = rewriteInlineCitations("[[doc-0 1-99]] [[doc-0 2-3]]", 50);
    const { citations, unresolved } = await resolveInlineCitations(entries, async () => BEFORE);
    expect(unresolved).toBe(1);
    expect(citations.map((c) => c.ref)).toEqual([2]);
  });

  it("keeps the shown text for a passage the edit removed, so verification flags it", async () => {
    const turn = {};
    const removed = BEFORE.replace("10.2 A notice is only effective if all rent is paid.", "");
    rememberReadText(turn, "doc-0", BEFORE);
    const id = idIn(BEFORE, "all rent is paid");
    const { entries } = rewriteInlineCitations(`[[doc-0 ${id}]]`, 50);
    const { citations } = await resolveInlineCitations(entries, async () => removed, { turn });
    expect((citations[0].quotes as { quote: string }[])[0].quote).toContain("all rent is paid");
  });
});

describe("the Word add-in", () => {
  it("cites the active document by its label", () => {
    expect(parseCitationTag("active-word-document 12")).toEqual([
      { kind: "passages", doc: "active-word-document", ranges: [[12, 12]] },
    ]);
    expect(rewriteInlineCitations("Notice [[active-word-document 3]].", 50).visible).toBe("Notice [1].");
  });

  it("cuts passage quotes to one line Word can search for", async () => {
    const long = `${"The Tenant shall keep the interior in good repair. ".repeat(8)}\nNext line.`;
    expect(locatableQuote(long, 200).length).toBeLessThanOrEqual(200);
    expect(locatableQuote(long, 200)).not.toContain("\n");
    expect(long).toContain(locatableQuote(long, 200));

    const turn = {};
    rememberReadText(turn, "active-word-document", long);
    const { entries } = rewriteInlineCitations("[[active-word-document 1]]", 50);
    const { citations } = await resolveInlineCitations(entries, async () => long, { turn, maxQuoteChars: 200 });
    const quote = (citations[0].quotes as { quote: string }[])[0].quote;
    expect(quote.length).toBeLessThanOrEqual(200);
    expect(long).toContain(quote);

    // A quote the model wrote is cut the same way.
    const own = long.split("\n")[0].trim();
    const quoted = rewriteInlineCitations(`[[active-word-document "${own}"]] [[active-word-document 1 "${own}"]]`, 50);
    const resolved = await resolveInlineCitations(quoted.entries, async () => long, { turn, maxQuoteChars: 200 });
    for (const c of resolved.citations) {
      const q = (c.quotes as { quote: string }[])[0].quote;
      expect(q.length).toBeLessThanOrEqual(200);
      expect(long).toContain(q);
    }
  });

  it("asks for inline tags, not cite_sources, in both edit modes", () => {
    for (const clientTools of [false, true]) {
      const inline = buildWordChatSystemPrompt(clientTools, "inline");
      expect(inline).toContain("[[active-word-document 12]]");
      expect(inline).not.toContain("cite_sources");
      expect(buildWordChatSystemPrompt(clientTools)).toContain("cite_sources");
    }
  });
});

describe("tabular review cells", () => {
  // Column positions are what the model sees (COL:0, COL:1); the cache is
  // keyed by each column's stored index, which differs after a deletion.
  const store: TableCells = {
    columns: [
      { index: 0, name: "Parties" },
      { index: 3, name: "Break date" },
    ],
    documents: [
      { id: "row-a", filename: "Lease A.pdf" },
      { id: "row-b", filename: "Lease B.pdf" },
    ],
    cells: new Map([
      ["0:row-a", { summary: "Harbourside Properties Limited and Quillon Analytics Ltd" }],
      ["3:row-a", { summary: "31 March 2030, on nine months' notice" }],
      ["3:row-b", null],
    ]),
  };

  it("parses COL/ROW tags, with an optional quote", () => {
    expect(parseCitationTag("COL:1 ROW:0")).toEqual([{ kind: "table", col: 1, row: 0 }]);
    expect(parseCitationTag('COL:1 ROW:0 "nine months"')).toEqual([
      { kind: "table", col: 1, row: 0, quote: "nine months" },
    ]);
    expect(parseCitationTag("COL:1 ROW:0 extra")).toBeNull();
  });

  it("cites a read cell by its stored column index, and gives no marker to one not read or empty", () => {
    const stream = createInlineCitationStream({
      maxCitations: 50,
      exists: (source) => tableSourceExists(store, source) ?? false,
    });
    const out =
      stream.push("Break [[COL:1 ROW:0]]. Parties [[COL:0 ROW:0]]. B [[COL:1 ROW:1]]. Unread [[COL:0 ROW:1]].") +
      stream.flush();
    expect(out).toBe("Break [1]. Parties [2]. B. Unread.");
    expect(stream.missingCount()).toBe(2);

    const { citations } = resolveTableCitations(stream.entries(), store);
    expect(citations[0]).toMatchObject({
      type: "tabular_citation",
      ref: 1,
      col_index: 1,
      row_index: 0,
      col_name: "Break date",
      doc_name: "Lease A.pdf",
      quote: "31 March 2030, on nine months' notice",
      verified: true,
    });
  });

  it("narrows to a quote only when it is in the cell", () => {
    const { entries } = rewriteInlineCitations('[[COL:1 ROW:0 "nine months"]] [[COL:0 ROW:0 "not there"]]', 50);
    const { citations } = resolveTableCitations(entries, store);
    expect(citations.map((c) => c.quote)).toEqual([
      "nine months",
      "Harbourside Properties Limited and Quillon Analytics Ltd",
    ]);
  });

  it("asks for tags, and hides earlier answers' markers, in inline mode", () => {
    const messages = [
      { role: "user", content: "Who are the parties?" },
      { role: "assistant", content: "Harbourside and Quillon [1]." },
      { role: "user", content: "And the break date?" },
    ] as never;
    const inline = buildTabularMessages(messages, store as never, "Leases", undefined, undefined, "inline") as {
      role: string; content: string;
    }[];
    expect(inline[0].content).toContain("[[COL:0 ROW:2]]");
    expect(inline[0].content).not.toContain("cite_sources");
    expect(inline[2].content).toBe("Harbourside and Quillon.");
    const citeSources = buildTabularMessages(messages, store as never, "Leases") as { content: string }[];
    expect(citeSources[0].content).toContain("cite_sources");
    expect(citeSources[2].content).toBe("Harbourside and Quillon [1].");
  });

  it("strips citation markers from earlier answers", () => {
    expect(stripCitationMarkers("A [1]. B [2][3].")).toBe("A. B.");
  });
});
