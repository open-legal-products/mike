import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractPlaybookWordStructure } from "../playbookWord";

async function sampleDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("word/styles.xml", `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style></w:styles>`);
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Limitation of Liability</w:t></w:r></w:p>
    <w:tbl><w:tr>
      <w:tc><w:p><w:r><w:t>Concept</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>Preferred clause</w:t></w:r></w:p><w:p><w:r><w:t>Liability is capped at fees paid.</w:t></w:r></w:p></w:tc>
    </w:tr></w:tbl>
    <w:p><w:r><w:t>Escalate uncapped liability to the General Counsel.</w:t></w:r></w:p>
  </w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("playbook Word extraction", () => {
  it("preserves heading and table-cell structure with stable source references", async () => {
    const structure = await extractPlaybookWordStructure(await sampleDocx());
    expect(structure.blocks).toHaveLength(3);
    expect(structure.blocks[0]).toMatchObject({ kind: "paragraph", sourceRef: "P1", level: 1, text: "Limitation of Liability" });
    expect(structure.blocks[1]).toMatchObject({ kind: "table", index: 1 });
    expect(structure.sources.map((source) => source.id)).toEqual(["P1", "T1R1C1", "T1R1C2", "P2"]);
    expect(structure.text).toContain("[T1R1C2] Preferred clause\nLiability is capped at fees paid.");
  });

  it("rejects archives without a readable Word body", async () => {
    const zip = new JSZip();
    zip.file("empty.txt", "empty");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    await expect(extractPlaybookWordStructure(buffer)).rejects.toThrow(/document body/i);
  });
});
