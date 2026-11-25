// Runs the real Docxodus WebAssembly engine, with no mocks, on Word documents
// built in the test. The redline is then read back with Mike's own DOCX code
// (the upload validator and the tracked-changes text extractor), because those
// are what will meet it in production.
import JSZip from "jszip";
import { beforeAll, describe, expect, it } from "vitest";
import { agreementDocx, ORIGINAL_CLAUSES, REVISED_CLAUSES } from "../../__tests__/helpers/docxFixtures";
import { docxodusDiffEngine } from "../docxDiff/docxodus";
import { DocxDiffError } from "../docxDiff";
import { extractDocxBodyText } from "../docxTrackedChanges";
import { validateDocxPackage } from "../docxpackagevalidation";

const OPTIONS = { author: "Mike comparison", date: new Date("2026-11-24T12:00:00Z") };
const arrayBuffer = (buffer: Buffer) => Uint8Array.from(buffer).buffer;
const documentXml = async (docx: Buffer) =>
  (await JSZip.loadAsync(docx)).file("word/document.xml")!.async("string");

describe("Docxodus diff engine (real WebAssembly runtime)", () => {
  let original: Buffer;
  let revised: Buffer;
  let result: Buffer;
  beforeAll(async () => {
    original = await agreementDocx(ORIGINAL_CLAUSES);
    revised = await agreementDocx(REVISED_CLAUSES);
    result = await docxodusDiffEngine.compare(original, revised, OPTIONS);
  }, 60_000);

  it("writes a redline that passes Mike's upload validation", async () => {
    expect(await validateDocxPackage(arrayBuffer(result))).toBe(true);
  });

  it("reads as the revised document once every change is accepted", async () => {
    // extractDocxBodyText is Mike's accepted view: insertions kept, deletions dropped.
    expect(await extractDocxBodyText(result)).toBe(await extractDocxBodyText(revised));
  });

  it("keeps the original wording as tracked deletions", async () => {
    const xml = await documentXml(result);
    expect(xml).toMatch(/<w:del\b[^>]*>(?:(?!<\/w:del>).)*<w:delText[^>]*>thirty \(30<\/w:delText>/s);
    expect(xml).not.toContain("<w:delText>sixty");
  });

  it("stamps each change with the requested author and date and a w:id a viewer can target", async () => {
    const xml = await documentXml(result);
    const marks = [...xml.matchAll(/<w:(?:ins|del)\b[^>]*>/g)].map(([tag]) => tag);
    expect(marks.length).toBeGreaterThanOrEqual(3);
    for (const tag of marks) {
      expect(tag).toMatch(/w:id="\d+"/);
      expect(tag).toContain('w:author="Mike comparison"');
      expect(tag).toContain('w:date="2026-11-24T12:00:00Z"');
    }
  });

  it("finds no changes between a document and itself", async () => {
    const same = await docxodusDiffEngine.compare(original, original, OPTIONS);
    expect(await documentXml(same)).not.toMatch(/<w:(?:ins|del)\b/);
    expect(await extractDocxBodyText(same)).toBe(await extractDocxBodyText(original));
  });

  it("compares the accepted text of a version that still has pending tracked changes", async () => {
    // What an assistant edit leaves behind: the revised wording as a pending
    // suggestion. Compared with the original it is a real difference; compared
    // with a clean copy of the same wording it is not.
    const suggested = await agreementDocx([
      ["The Supplier shall deliver the Services within ", { del: "thirty (30)" }, { ins: "sixty (60)" }, " days."],
      ...ORIGINAL_CLAUSES.slice(1),
    ]);
    const clean = await agreementDocx([REVISED_CLAUSES[0], ...ORIGINAL_CLAUSES.slice(1)]);

    const againstOriginal = await docxodusDiffEngine.compare(original, suggested, OPTIONS);
    expect(await documentXml(againstOriginal)).toMatch(/<w:ins\b/);
    // The suggestion's own author is not carried into the redline.
    expect(await documentXml(againstOriginal)).not.toContain('w:author="Reviewer"');

    const againstClean = await docxodusDiffEngine.compare(suggested, clean, OPTIONS);
    expect(await documentXml(againstClean)).not.toMatch(/<w:(?:ins|del)\b/);
  });

  it("is direction-sensitive: swapping the versions swaps insertions and deletions", async () => {
    const reversed = await docxodusDiffEngine.compare(revised, original, OPTIONS);
    // Mike's extractor keeps an empty line where a whole paragraph is a
    // tracked deletion (it drops the text but not the paragraph), so compare
    // the lines that carry text.
    const lines = (text: string) => text.split("\n").filter(Boolean);
    expect(lines(await extractDocxBodyText(reversed))).toEqual(lines(await extractDocxBodyText(original)));
  });

  it.each([
    ["text that is not a zip archive", Buffer.from("not a word document")],
    ["an empty file", Buffer.alloc(0)],
  ])("rejects %s with a DocxDiffError instead of a redline", async (_label, bytes) => {
    await expect(docxodusDiffEngine.compare(original, bytes, OPTIONS)).rejects.toBeInstanceOf(DocxDiffError);
    await expect(docxodusDiffEngine.compare(bytes, revised, OPTIONS)).rejects.toBeInstanceOf(DocxDiffError);
  });
});
