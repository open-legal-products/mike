import { beforeEach, expect, it, vi } from "vitest";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import JSZip from "jszip";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { extractDocumentText } from "../../../lib/extraction/documentText";
const mocks = vi.hoisted(() => ({ state: vi.fn(), download: vi.fn(), extract: vi.fn() }));
vi.mock("../../../lib/documentVersions", () => ({ attachActiveVersionPaths: vi.fn(async () => {}) }));
vi.mock("../../../lib/documentTextCache", async load => ({ ...await load<object>(), loadVersionTextState: mocks.state }));
vi.mock("../../../lib/storage", () => ({ downloadFile: mocks.download }));
vi.mock("../../../lib/extraction/isolated", async load => ({ ...await load<object>(), runIsolatedExtraction: mocks.extract }));
import { loadRowDocumentText, type ReviewRow } from "../tabular.rows";

beforeEach(() => {
    vi.clearAllMocks();
    // Exercise the real parser, while asserting the bounded-worker protocol.
    mocks.extract.mockImplementation(async (op, load, options) => {
        expect(op).toBe("documentText");
        return extractDocumentText(await load(), options.fileType);
    });
});
async function warmAndCold(bytes: ArrayBuffer, fileType: string) {
    const indexed = await extractDocumentText(bytes, fileType);
    mocks.download.mockResolvedValue(bytes);
    const row = { id: "row", document_id: "doc" } as ReviewRow;
    const db = () => scriptedDb([{ table: "documents", data: [{ id: "doc", filename: `source.${fileType}`, storage_path: "source", current_version_id: "v", file_type: fileType }] }]).db;
    mocks.state.mockResolvedValue({ revision: "r", text: null, textlessPageCount: 0 });
    const cold = await loadRowDocumentText(db(), row);
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    mocks.state.mockResolvedValue({ revision: "r", text: indexed.text, textlessPageCount: indexed.textlessPageCount ?? 0 });
    const warm = await loadRowDocumentText(db(), row);
    expect(warm).toBe(cold);
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    return warm;
}
it("uses identical accepted DOCX text with headings, bold text and tracked changes", async () => {
    const doc = new Document({ sections: [{ children: [
        new Paragraph({ text: "Payment terms", heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ children: [new TextRun({ text: "Rent is 1200.", bold: true })] }),
    ] }] });
    const zip = await JSZip.loadAsync(await Packer.toBuffer(doc));
    const xml = await zip.file("word/document.xml")!.async("string");
    zip.file("word/document.xml", xml.replace("</w:body>", '<w:p><w:del w:id="1"><w:r><w:delText>Obsolete rent is 900.</w:delText></w:r></w:del><w:ins w:id="2"><w:r><w:t>Accepted rent is 1200.</w:t></w:r></w:ins></w:p></w:body>'));
    const output = await warmAndCold(Uint8Array.from(await zip.generateAsync({ type: "nodebuffer" })).buffer, "docx");
    expect(output).toContain("Payment terms\nRent is 1200.\nAccepted rent is 1200.");
    expect(output).not.toContain("Obsolete");
    expect(output).not.toContain("**Rent");
});

it("uses identical PDF page markers, form text and OCR notices", async () => {
    const content = "BT /F1 12 Tf 72 720 Td (Case No.:) Tj ET";
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>",
        "<< /Type /Pages /Kids [3 0 R 9 0 R] /Count 2 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [7 0 R 8 0 R] >>",
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        "<< /Fields [7 0 R 8 0 R] /NeedAppearances true /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >> >>",
        "<< /Type /Annot /Subtype /Widget /FT /Tx /T (CaseNumber) /V (24CV-1234) /Rect [140 710 250 730] /P 3 0 R /F 4 >>",
        "<< /Type /Annot /Subtype /Widget /FT /Tx /Ff 8192 /T (AccountPassword) /V (secret123) /Rect [140 680 250 700] /P 3 0 R /F 4 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    ];
    let pdf = "%PDF-1.7\n";
    const offsets: number[] = [];
    for (const [index, object] of objects.entries()) {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const output = await warmAndCold(Uint8Array.from(Buffer.from(pdf)).buffer, "pdf");
    expect(output).toContain("[Page 1]");
    expect(output).toContain("[CaseNumber: 24CV-1234]");
    expect(output).toContain("[Page 2]");
    expect(output).toContain("1 page(s) have no text layer and need OCR");
    expect(output).not.toContain("secret123");
});
