import { DeletedTextRun, Document, HeadingLevel, InsertedTextRun, Packer, Paragraph, TextRun } from "docx";

type Clause = string | Array<string | { ins: string } | { del: string }>;

/**
 * A small agreement as a real .docx. A clause is plain text, or runs that mix
 * plain text with pending tracked insertions and deletions.
 */
export async function agreementDocx(clauses: Clause[], title = "Services Agreement"): Promise<Buffer> {
  let revisionId = 100;
  const tracked = { author: "Reviewer", date: "2026-09-23T00:00:00Z" };
  const document = new Document({ sections: [{ children: [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(title)] }),
    ...clauses.map((clause) => new Paragraph({ children: (typeof clause === "string" ? [clause] : clause).map((run) =>
      typeof run === "string" ? new TextRun(run)
        : "ins" in run ? new InsertedTextRun({ text: run.ins, id: revisionId++, ...tracked })
        : new DeletedTextRun({ text: run.del, id: revisionId++, ...tracked })) })),
  ] }] });
  return Packer.toBuffer(document);
}

export const ORIGINAL_CLAUSES = [
  "The Supplier shall deliver the Services within thirty (30) days.",
  "Liability is capped at the fees paid in the preceding twelve months.",
  "This Agreement is governed by the laws of Texas.",
];

export const REVISED_CLAUSES = [
  "The Supplier shall deliver the Services within sixty (60) days.",
  "Liability is capped at the fees paid in the preceding twelve months.",
  "Either party may terminate on ninety days' written notice.",
  "This Agreement is governed by the laws of Texas.",
];
