import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractPlaybookWordStructure } from "../playbooks.word";

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
  it.each([
    ["&amp;lt; &amp;gt; &amp;quot; &amp;apos;", "&lt; &gt; &quot; &apos;"],
    ["&amp;#65; &amp;#x41; &#38;#x41;", "&#65; &#x41; &#x41;"],
    ["&amp;amp; &#38;lt; &#x26;lt;", "&amp; &lt; &lt;"],
    ["&amp; &lt; &gt; &quot; &apos; &#65; &#x41;", "& < > \" ' A A"],
  ])("decodes each XML reference once: %s", async (encoded, decoded) => {
    const zip = new JSZip();
    zip.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:p><w:pPr><w:pStyle w:val="${encoded}"/></w:pPr><w:r><w:t>${encoded}</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>${encoded}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    </w:body></w:document>`);

    const structure = await extractPlaybookWordStructure(await zip.generateAsync({ type: "nodebuffer" }));
    expect(structure.sources[0]).toMatchObject({ text: decoded, style: decoded });
    expect(structure.sources[1]).toMatchObject({ text: decoded });
  });

  it("preserves heading and table-cell structure with stable source references", async () => {
    const structure = await extractPlaybookWordStructure(await sampleDocx());
    expect(structure.blocks).toHaveLength(3);
    expect(structure.blocks[0]).toMatchObject({ kind: "paragraph", sourceRef: "P1", level: 1, text: "Limitation of Liability" });
    expect(structure.blocks[1]).toMatchObject({ kind: "table", index: 1 });
    expect(structure.sources.map((source) => source.id)).toEqual(["P1", "T1R1C1", "T1R1C2", "P2"]);
    expect(structure.text).toContain("[T1R1C2] Preferred clause\nLiability is capped at fees paid.");
  });

  it.each([
    [
      "line breaks",
      "<w:r><w:t>Line one</w:t><w:br/><w:t>Line two</w:t></w:r>",
      "Line one\nLine two",
    ],
    [
      "tabs",
      "<w:r><w:t>Cap</w:t><w:tab/><w:t>Fees paid</w:t></w:r>",
      "Cap\tFees paid",
    ],
    [
      "carriage returns",
      "<w:r><w:t>One</w:t><w:cr/><w:t>Two</w:t></w:r>",
      "One\nTwo",
    ],
    [
      "page breaks",
      '<w:r><w:t>Before</w:t><w:br w:type="page"/><w:t>After</w:t></w:r>',
      "Before\nAfter",
    ],
    [
      "empty text runs",
      "<w:r><w:t/><w:t>Real text</w:t></w:r>",
      "Real text",
    ],
    [
      "preserved whitespace across runs",
      '<w:r><w:t xml:space="preserve">Hello </w:t><w:t>world</w:t></w:r>',
      "Hello world",
    ],
  ])("keeps the text that follows %s", async (_label, runs, expected) => {
    const zip = new JSZip();
    zip.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>${runs}</w:p></w:body></w:document>`);
    const structure = await extractPlaybookWordStructure(await zip.generateAsync({ type: "nodebuffer" }));
    expect(structure.sources[0]?.text).toBe(expected);
  });

  it("keeps every cell of a multi-line table row", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:tbl><w:tr>
        <w:tc><w:p><w:r><w:t>Standard</w:t><w:br/><w:t>Mutual cap</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Fallback</w:t><w:br/><w:t>Cap at 2x fees</w:t></w:r></w:p></w:tc>
      </w:tr></w:tbl>
    </w:body></w:document>`);
    const structure = await extractPlaybookWordStructure(await zip.generateAsync({ type: "nodebuffer" }));
    expect(structure.sources.map((source) => source.text)).toEqual([
      "Standard\nMutual cap",
      "Fallback\nCap at 2x fees",
    ]);
  });

  it("rejects archives without a readable Word body", async () => {
    const zip = new JSZip();
    zip.file("empty.txt", "empty");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    await expect(extractPlaybookWordStructure(buffer)).rejects.toThrow(/document body/i);
  });
});
