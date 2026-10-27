import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { uploadFileMock } = vi.hoisted(() => ({
  uploadFileMock: vi.fn(),
}));

vi.mock("../../../../lib/storage", () => ({
  downloadFile: vi.fn(),
  generatedDocKey: (userId: string, docId: string, filename: string) =>
    `generated/${userId}/${docId}/${filename}`,
  uploadFile: (...args: unknown[]) => uploadFileMock(...args),
}));

vi.mock("../../../../lib/downloadTokens", () => ({
  buildDownloadUrl: () => "/download/test-token",
}));

import { generateDocx } from "../tools/documentOps";

const noVisuals = async () => ({ error: "no visuals in this test" });

function fakeDb() {
  return {
    rpc: vi.fn(async () => ({ data: { id: "version-1", version_number: 1 }, error: null })),
    from(table: string) {
      const result = { data: null, error: null };
      const query: Record<string, unknown> = {};
      query.insert = vi.fn(() => query);
      query.select = vi.fn(() => query);
      query.update = vi.fn(() => query);
      query.eq = vi.fn(() => query);
      query.single = vi.fn(async () => ({
        data: { id: table === "documents" ? "doc-1" : "version-1" },
        error: null,
      }));
      query.then = (
        resolve: (value: typeof result) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject);
      return query;
    },
  };
}

async function generatedXml(options: {
  sections: unknown[];
  numberSections?: boolean;
}): Promise<{ documentXml: string; numberingXml: string }> {
  let bytes: ArrayBuffer | undefined;
  uploadFileMock.mockImplementationOnce(
    async (_key: string, uploaded: ArrayBuffer) => {
      bytes = uploaded;
    },
  );

  const result = await generateDocx(
    "Generated document",
    options.sections,
    "test-user",
    fakeDb() as never,
    { numberSections: options.numberSections, resolveVisual: noVisuals },
  );

  expect(result).not.toHaveProperty("error");
  expect(bytes).toBeDefined();
  const archive = await JSZip.loadAsync(bytes!);
  const documentXml = await archive.file("word/document.xml")!.async("string");
  const numberingXml = await archive.file("word/numbering.xml")!.async("string");
  return { documentXml, numberingXml };
}

it("writes a visual section's blocks as headings, text, a table and a picture", async () => {
  let bytes: ArrayBuffer | undefined;
  uploadFileMock.mockImplementationOnce(async (_key: string, uploaded: ArrayBuffer) => {
    bytes = uploaded;
  });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );

  const result = await generateDocx(
    "With a visual",
    [{ visual: { doc_id: "doc-3", caption: "Figure 1" } }],
    "test-user",
    fakeDb() as never,
    {
      resolveVisual: async (docId) =>
        docId === "doc-3"
          ? {
              blocks: [
                { type: "heading", level: 2, text: "Rent" },
                { type: "paragraph", text: "Rent is payable quarterly." },
                { type: "table", header: true, numeric: [false, true], rows: [["Year", "Rent"], ["2026", "120,000"]] },
                { type: "image", png, widthPx: 1200, heightPx: 300, alt: "Rent by year" },
              ],
            }
          : { error: "missing" },
    },
  );

  expect(result).not.toHaveProperty("error");
  const archive = await JSZip.loadAsync(bytes!);
  const documentXml = await archive.file("word/document.xml")!.async("string");
  expect(paragraphContaining(documentXml, "Rent")).toContain('<w:pStyle w:val="Heading2"/>');
  const cell = documentXml.match(/<w:tc>(?:(?!<\/w:tc>)[\s\S])*120,000[\s\S]*?<\/w:tc>/)![0];
  expect(cell).toContain('<w:jc w:val="right"/>');
  expect(documentXml).toContain('descr="Rent by year"');
  expect(paragraphContaining(documentXml, "Figure 1")).toContain('<w:pStyle w:val="Caption"/>');
  const [, cx, cy] = documentXml.match(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/)!;
  expect(Number(cx) / 9525).toBeCloseTo(602, 0);
  expect(Number(cy) / 9525).toBeCloseTo(151, 0);
});

function paragraphContaining(xml: string, text: string): string {
  return (
    xml
      .match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)
      ?.find((paragraph) => paragraph.includes(text)) ?? ""
  );
}

beforeEach(() => {
  uploadFileMock.mockReset();
});

describe("generateDocx numbering", () => {
  it("leaves demand-letter headings and prose unnumbered by default", async () => {
    const { documentXml } = await generatedXml({
      sections: [
        {
          heading: "Demand for Payment",
          content:
            "We represent the claimant.\nPayment is required within ten days.",
        },
      ],
    });

    expect(paragraphContaining(documentXml, "DEMAND FOR PAYMENT")).not.toContain(
      "<w:numPr>",
    );
    expect(
      paragraphContaining(documentXml, "We represent the claimant."),
    ).not.toContain("<w:numPr>");
    expect(
      paragraphContaining(documentXml, "Payment is required within ten days."),
    ).not.toContain("<w:numPr>");
  });

  it("numbers only headings when legal section numbering is requested", async () => {
    const { documentXml } = await generatedXml({
      numberSections: true,
      sections: [
        {
          heading: "Payment Terms",
          content: "Payment is due monthly.\nInvoices are payable in ten days.",
        },
      ],
    });

    expect(paragraphContaining(documentXml, "PAYMENT TERMS")).toContain(
      "<w:numPr>",
    );
    expect(paragraphContaining(documentXml, "Payment is due monthly.")).not.toContain(
      "<w:numPr>",
    );
    expect(
      paragraphContaining(documentXml, "Invoices are payable in ten days."),
    ).not.toContain("<w:numPr>");
  });

  it("preserves manually typed numbering when automatic numbering is off", async () => {
    const { documentXml } = await generatedXml({
      sections: [{ content: "1. This reference is intentional." }],
    });
    const paragraph = paragraphContaining(
      documentXml,
      "1. This reference is intentional.",
    );

    expect(paragraph).toContain("1. This reference is intentional.");
    expect(paragraph).not.toContain("<w:numPr>");
  });

  it("renders explicit bullets as bullets rather than legal clauses", async () => {
    const { documentXml, numberingXml } = await generatedXml({
      numberSections: true,
      sections: [
        {
          heading: "Requirements",
          content: "- First item\n- Second item",
        },
      ],
    });

    const first = paragraphContaining(documentXml, "First item");
    const second = paragraphContaining(documentXml, "Second item");
    expect(first).toContain("<w:numPr>");
    expect(second).toContain("<w:numPr>");
    expect(first).not.toContain("- First item");
    expect(second).not.toContain("- Second item");
    expect(numberingXml).toContain('<w:numFmt w:val="bullet"/>');
  });
});
