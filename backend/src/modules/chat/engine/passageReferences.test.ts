import { expect, it } from "vitest";
import { createCitationRecorder, documentCitations } from "./citeSources";
import { PassageReferences } from "./passageReferences";

const source = { document_id: "a", filename: "Lease.txt", version_id: "v1" };
const lease = "Notice is required.";
function setup() {
  const recorder = createCitationRecorder(documentCitations({
    docStore: new Map(), docIndex: { "doc-0": source }, casesByClusterId: new Map(),
    readSourceText: async () => lease, getCaseOpinions: async () => [],
  }));
  const passages = new PassageReferences(recorder.insertPassage);
  const handle = passages.annotate(lease, "doc-0", source).split(" ")[0];
  return { recorder, passages, handle };
}

it("holds the same ref across every split, and prevents the quote tool from overwriting it", async () => {
  const { recorder, passages, handle } = setup();
  for (let i = 0; i <= handle.length; i++) {
    expect(passages.push(handle.slice(0, i)) + passages.push(handle.slice(i))).toBe("[1]");
  }
  const entry = { doc_id: "doc-0", quotes: [{ quote: lease }] };
  const { event } = await recorder.record({ citations: [{ ...entry, ref: 1 }, { ...entry, ref: 2 }] });
  expect(event).toMatchObject({ refs: [2], rejected: 1 });
  expect(recorder.citations()).toHaveLength(2);
});

it("marks unknown and interrupted handles unavailable, without confusing ordinary brackets", () => {
  const { passages, handle } = setup();
  expect(passages.push(handle.replace(":1", ":9999"))).toBe("[source unavailable]");
  expect(passages.push("see [")).toBe("see ");
  expect(passages.push("1].")).toBe("[1].");
  expect(passages.push(handle.slice(0, -2))).toBe("");
  expect(passages.flush()).toBe("[source unavailable]");
  expect(passages.unknown).toBe(2);
});

it("leaves reads with a synthetic OCR notice on the quote-verification path", () => {
  const { passages } = setup();
  const text = "[1 page(s) have no text layer and need OCR. Search coverage is incomplete.]\n\n" + lease;
  expect(passages.annotate(text, "doc-0", { ...source, filename: "Lease.pdf" })).toBe(text);
});
