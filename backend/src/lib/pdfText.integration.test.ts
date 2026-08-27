import { describe, expect, it } from "vitest";

import { extractPdfText } from "./pdfText";

function buildFilledAcroFormPdf(): ArrayBuffer {
  const content = "BT /F1 12 Tf 72 720 Td (Case No.:) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [7 0 R 8 0 R] >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Fields [7 0 R 8 0 R] /NeedAppearances true /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >> >>",
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (CaseNumber) /V (24CV-1234) /Rect [140 710 250 730] /P 3 0 R /F 4 >>",
    "<< /Type /Annot /Subtype /Widget /FT /Tx /Ff 8192 /T (AccountPassword) /V (secret123) /Rect [140 680 250 700] /P 3 0 R /F 4 >>",
  ];

  let pdf = "%PDF-1.7\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;

  const bytes = Buffer.from(pdf, "binary");
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

describe("extractPdfText AcroForm integration", () => {
  it("reads a real text field while excluding a real password field", async () => {
    const source = buildFilledAcroFormPdf();
    const text = await extractPdfText(source);

    expect(text).toContain("Case No.:");
    expect(text).toContain("[CaseNumber: 24CV-1234]");
    expect(text).not.toContain("[Page 1 form fields]");
    expect(text).not.toContain("AccountPassword");
    expect(text).not.toContain("secret123");
  });
});
