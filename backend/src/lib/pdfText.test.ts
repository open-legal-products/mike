import { describe, expect, it, vi } from "vitest";

type FakeItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
};

type FakeAnnotation = {
  fieldName?: unknown;
  fieldValue?: unknown;
  password?: boolean;
  fieldFlags?: unknown;
  radioButton?: boolean;
  checkBox?: boolean;
  buttonValue?: unknown;
  rect?: unknown;
};

type FakeAnnotationResult = FakeAnnotation[] | Error;

// Positioned pdfjs text items: transform [a, b, c, d, x, y], y grows upward.
function item(str: string, x: number, y: number, hasEOL = false): FakeItem {
  return {
    str,
    transform: [1, 0, 0, 12, x, y],
    width: str.length * 6,
    height: 12,
    hasEOL,
  };
}

function fakePdf(
  pages: FakeItem[][],
  annotations: FakeAnnotationResult[] = [],
) {
  return {
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: pages.length,
        getPage: (n: number) => {
          const pageAnnotations = annotations[n - 1] ?? [];
          return Promise.resolve({
            getTextContent: () => Promise.resolve({ items: pages[n - 1] }),
            getAnnotations: () =>
              pageAnnotations instanceof Error
                ? Promise.reject(pageAnnotations)
                : Promise.resolve(pageAnnotations),
          });
        },
      }),
    }),
  };
}

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: (opts: unknown) =>
    (
      globalThis as { __fakePdf?: ReturnType<typeof fakePdf> }
    ).__fakePdf!.getDocument(),
}));

import {
  countPagesWithoutText,
  extractPdfText,
  extractPdfTextForModel,
  textLayerNotice,
} from "./pdfText";

function withPdf(
  pages: FakeItem[][],
  annotations: FakeAnnotationResult[] = [],
) {
  (globalThis as { __fakePdf?: ReturnType<typeof fakePdf> }).__fakePdf =
    fakePdf(pages, annotations);
}

describe("extractPdfText layout reconstruction", () => {
  it.each([0, 0.5, 1])(
    "joins kerning fragments separated by %s points",
    async (gap) => {
      withPdf([[item("constitut", 72, 700), item("e", 126 + gap, 700, true)]]);

      await expect(extractPdfText(new ArrayBuffer(8))).resolves.toBe(
        "[Page 1]\nconstitute",
      );
    },
  );

  it.each([3, 3.34, 4, 6])(
    "preserves a %s-point word gap without embedded whitespace",
    async (gap) => {
      withPdf([
        [item("Agreement", 72, 700), item("Terms", 126 + gap, 700, true)],
      ]);

      await expect(extractPdfText(new ArrayBuffer(8))).resolves.toBe(
        "[Page 1]\nAgreement Terms",
      );
    },
  );

  it.each([false, true])(
    "reunites interleaved table rows regardless of hasEOL=%s",
    async (hasEOL) => {
      withPdf([
        [
          item("Left top", 72, 700, hasEOL),
          item("Left bottom", 72, 686, hasEOL),
          item("Right top", 400, 700, hasEOL),
          item("Right bottom", 400, 686, hasEOL),
        ],
      ]);

      await expect(extractPdfText(new ArrayBuffer(8))).resolves.toBe(
        `[Page 1]\nLeft top${" ".repeat(16)}Right top\nLeft bottom${" ".repeat(16)}Right bottom`,
      );
    },
  );

  it("reads down each column of a two-column page", async () => {
    // The counterpart to the table above, and the regression this exists for:
    // a table row reads across, but a two-column page reads down. Grouping by
    // baseline alone glued the left column's line to the right column's, so a
    // quote spanning two lines of one column was not contiguous in the
    // extracted text and failed citation verification outright.
    const left = [
      "The defendant contends that the statute of",
      "limitations had expired before the complaint",
      "was filed, and that the tolling agreement is",
      "unenforceable for want of consideration.",
    ];
    const right = [
      "We disagree. The record shows the parties",
      "exchanged mutual promises to forbear suit,",
      "which this court has long held sufficient to",
      "support a tolling agreement.",
    ];
    // `item` reports 6pt per character, so the widest left line ends 18pt
    // short of the right column: a gutter, not a word gap.
    const rightX = 72 + Math.max(...left.map((l) => l.length * 6)) + 18;
    withPdf([
      [
        ...left.map((line, i) => item(line, 72, 700 - i * 14)),
        ...right.map((line, i) => item(line, rightX, 700 - i * 14)),
      ],
    ]);

    // Each column's lines stay contiguous. The right column keeps the indent
    // its x position implies, which whitespace-normalized quote matching
    // collapses.
    const indent = " ".repeat(24);
    await expect(extractPdfText(new ArrayBuffer(8))).resolves.toBe(
      [
        "[Page 1]",
        ...left,
        "",
        ...right.map((line) => indent + line),
      ].join("\n"),
    );
  });

  it("keeps a full-width heading above the columns it introduces", async () => {
    // A heading spanning both columns breaks the gutter, so requiring one
    // unbroken over the whole page would find no columns at all on exactly
    // the pages that have them.
    // Three lines a side: a column is a block of text, so a candidate gutter
    // supported by only a row or two is not taken as one.
    const left = [
      "Left line one aaaaaaaaaa",
      "Left line two aaaaaaaaaa",
      "Left line three aaaaaaaa",
    ];
    const right = [
      "Right line one bbbbbbbbb",
      "Right line two bbbbbbbbb",
      "Right line three bbbbbbb",
    ];
    const rightX = 72 + 24 * 6 + 18;
    withPdf([
      [
        item("OPINION OF THE COURT", 72, 730),
        ...left.map((line, i) => item(line, 72, 700 - i * 14)),
        ...right.map((line, i) => item(line, rightX, 700 - i * 14)),
      ],
    ]);

    const text = await extractPdfText(new ArrayBuffer(8));
    expect(text.indexOf("OPINION OF THE COURT")).toBeLessThan(
      text.indexOf("Left line one"),
    );
    expect(text).toContain(`${left[0]}\n${left[1]}`);
    expect(text.indexOf(left[1])).toBeLessThan(text.indexOf(right[0]));
  });

  it("groups near-equal baselines and sorts fragments by X", async () => {
    withPdf([
      [
        item("Terms", 129, 701, true),
        item("Next row", 72, 686, true),
        item("Agreement", 72, 700, true),
      ],
    ]);

    await expect(extractPdfText(new ArrayBuffer(8))).resolves.toBe(
      "[Page 1]\nAgreement Terms\nNext row",
    );
  });

  it("rebuilds lines from positions instead of joining every item", async () => {
    // Two lines on page 1: a title and an indented body line that pdfjs split
    // into kerning fragments with no real word gap between them.
    withPdf([
      [
        item("MASTER TERMS", 72, 700, true),
        item("1.1", 108, 686),
        item("Affiliate", 132, 686),
        item(" means", 186, 686),
        item(" any entity", 222, 686, true),
      ],
    ]);

    const text = await extractPdfText(new ArrayBuffer(8));
    expect(text).toBe(
      "[Page 1]\nMASTER TERMS\n      1.1 Affiliate means any entity",
    );
  });

  it("inserts a blank line for paragraph-scale vertical gaps", async () => {
    withPdf([
      [
        item("First paragraph.", 72, 700, true),
        item("Second paragraph.", 72, 640, true),
      ],
    ]);

    const text = await extractPdfText(new ArrayBuffer(8));
    expect(text).toContain("First paragraph.\n\nSecond paragraph.");
  });

  it("preserves obvious column gaps (signature blocks)", async () => {
    // Wide x-gap between two items on the same visual line.
    withPdf([[item("CLIENT", 72, 700), item("SAAS PROVIDER", 400, 700, true)]]);

    const text = await extractPdfText(new ArrayBuffer(8));
    expect(text).toMatch(/CLIENT\s{4,}SAAS PROVIDER/);
  });

  it("keeps page markers and orders pages", async () => {
    withPdf([
      [item("page one", 72, 700, true)],
      [item("page two", 72, 700, true)],
    ]);

    const text = await extractPdfText(new ArrayBuffer(8));
    expect(text).toBe("[Page 1]\npage one\n\n[Page 2]\npage two");
  });

  it("appends non-empty form values without changing page text layout", async () => {
    withPdf(
      [[item("Case", 72, 700), item("No.:", 102, 700)]],
      [
        [
          {
            fieldName: "CaseNumber",
            fieldValue: "24CV-1234",
            rect: [140, 690, 250, 710],
          },
          { fieldName: "EmptyField", fieldValue: "" },
          { fieldName: undefined, fieldValue: "ignored" },
        ],
      ],
    );

    await expect(extractPdfText(new ArrayBuffer(8))).resolves.toBe(
      "[Page 1]\nCase No.: [CaseNumber: 24CV-1234]",
    );
  });

  it("orders positioned form fields between surrounding page text", async () => {
    withPdf(
      [[item("Before", 72, 720), item("After", 72, 660)]],
      [
        [
          {
            fieldName: "Answer",
            fieldValue: "In context",
            rect: [72, 680, 220, 700],
          },
        ],
      ],
    );

    const text = await extractPdfText(new ArrayBuffer(8));
    expect(text.indexOf("Before")).toBeLessThan(text.indexOf("[Answer"));
    expect(text.indexOf("[Answer")).toBeLessThan(text.indexOf("After"));
    expect(text).not.toContain("form fields");
  });

  it("does not expose password field values", async () => {
    withPdf(
      [[]],
      [
        [
          { fieldName: "Username", fieldValue: "alice" },
          {
            fieldName: "AccountPassword",
            fieldValue: "secret123",
            fieldFlags: 1 << 13,
          },
          {
            fieldName: "LegacyPasswordShape",
            fieldValue: "secret456",
            password: true,
          },
        ],
      ],
    );

    const text = await extractPdfText(new ArrayBuffer(8));
    expect(text).toContain("Username: alice");
    expect(text).not.toContain("AccountPassword");
    expect(text).not.toContain("secret123");
    expect(text).not.toContain("LegacyPasswordShape");
    expect(text).not.toContain("secret456");
  });

  it("emits only the selected radio widget and deduplicates it", async () => {
    withPdf(
      [[]],
      [
        [
          {
            fieldName: "Plan",
            fieldValue: "Premium",
            radioButton: true,
            buttonValue: "Basic",
          },
          {
            fieldName: "Plan",
            fieldValue: "Premium",
            radioButton: true,
            buttonValue: "Premium",
          },
          {
            fieldName: "Plan",
            fieldValue: "Premium",
            radioButton: true,
            buttonValue: "Premium",
          },
          {
            fieldName: "Plan",
            fieldValue: "Premium",
            radioButton: true,
            buttonValue: "Enterprise",
          },
        ],
      ],
    );

    const text = await extractPdfText(new ArrayBuffer(8));
    expect(text.match(/Plan: Premium/g)).toHaveLength(1);
  });

  it("keeps checkbox values and deduplicates repeated widgets", async () => {
    withPdf(
      [[]],
      [
        [
          { fieldName: "Accepted", fieldValue: "Yes", checkBox: true },
          { fieldName: "Accepted", fieldValue: "Yes", checkBox: true },
          { fieldName: "Declined", fieldValue: "Off", checkBox: true },
        ],
      ],
    );

    await expect(extractPdfText(new ArrayBuffer(8))).resolves.toContain(
      "[Page 1 form fields]\nAccepted: Yes\nDeclined: Off",
    );
  });

  it("formats multi-select values and skips unsupported value shapes", async () => {
    withPdf(
      [[]],
      [
        [
          { fieldName: "Topics", fieldValue: ["Contracts", "Privacy"] },
          { fieldName: "Unsupported", fieldValue: { value: "hidden" } },
        ],
      ],
    );

    const text = await extractPdfText(new ArrayBuffer(8));
    expect(text).toContain("Topics: Contracts, Privacy");
    expect(text).not.toContain("Unsupported");
    expect(text).not.toContain("[object Object]");
  });

  it("keeps page text when reading annotations fails", async () => {
    withPdf([[item("Visible text", 72, 700)]], [new Error("boom")]);

    await expect(extractPdfText(new ArrayBuffer(8))).resolves.toBe(
      "[Page 1]\nVisible text",
    );
  });

  it("returns an empty string when pdfjs cannot read the buffer", async () => {
    (globalThis as { __fakePdf?: unknown }).__fakePdf = {
      getDocument: () => ({ promise: Promise.reject(new Error("bad pdf")) }),
    };

    await expect(extractPdfText(new ArrayBuffer(8))).resolves.toBe("");
  });
});

describe("text layer detection", () => {
  const unreadable = () => {
    (globalThis as { __fakePdf?: unknown }).__fakePdf = {
      getDocument: () => ({ promise: Promise.reject(new Error("bad pdf")) }),
    };
  };

  it("leaves a PDF with text on every page unchanged", async () => {
    withPdf([[item("Intro", 72, 700)], [item("Terms", 72, 700)]]);

    await expect(extractPdfTextForModel(new ArrayBuffer(8))).resolves.toBe(
      "[Page 1]\nIntro\n\n[Page 2]\nTerms",
    );
    await expect(countPagesWithoutText(new ArrayBuffer(8))).resolves.toBe(0);
  });

  it("replaces a fully scanned PDF with a single notice", async () => {
    withPdf([[], []]);

    await expect(extractPdfTextForModel(new ArrayBuffer(8))).resolves.toBe(
      "[This PDF has no text layer, so its content cannot be read. It is most likely a scanned document that needs OCR.]",
    );
    await expect(countPagesWithoutText(new ArrayBuffer(8))).resolves.toBe(2);
  });

  it("names the pages without text in a partly scanned PDF", async () => {
    withPdf([
      [item("Brief", 72, 700)],
      [],
      [],
      [],
      [item("Closing", 72, 700)],
      [],
    ]);

    const text = await extractPdfTextForModel(new ArrayBuffer(8));
    expect(text).toMatch(
      /^\[Pages 2–4, 6 of this PDF have no text layer, so their content cannot be read\. They are most likely scanned and need OCR\.\]\n\n\[Page 1\]\nBrief/,
    );
    await expect(countPagesWithoutText(new ArrayBuffer(8))).resolves.toBe(4);
  });

  it("uses the singular for one page without text", () => {
    expect(textLayerNotice([2], 3)).toMatch(
      /^\[Page 2 of this PDF has no text layer/,
    );
  });

  it("treats a content line that reads like a page marker as text", async () => {
    withPdf([[item("[Page 2]", 72, 700)], [item("Terms", 72, 700)]]);

    await expect(countPagesWithoutText(new ArrayBuffer(8))).resolves.toBe(0);
    await expect(extractPdfTextForModel(new ArrayBuffer(8))).resolves.toBe(
      "[Page 1]\n[Page 2]\n\n[Page 2]\nTerms",
    );
  });

  it("counts unpositioned form field values as page text", async () => {
    withPdf([[]], [[{ fieldName: "Name", fieldValue: "Jane Doe" }]]);

    await expect(countPagesWithoutText(new ArrayBuffer(8))).resolves.toBe(0);
  });

  it("reports an unreadable PDF as unknown, not as fully readable", async () => {
    unreadable();
    await expect(countPagesWithoutText(new ArrayBuffer(8))).resolves.toBeNull();
    await expect(extractPdfTextForModel(new ArrayBuffer(8))).resolves.toBe("");
  });

  it("destroys the pdfjs loading task after reading, and after a failure", async () => {
    const destroy = vi.fn(() => Promise.resolve());
    const readable = fakePdf([[item("Text", 72, 700)]]);
    (globalThis as { __fakePdf?: unknown }).__fakePdf = {
      getDocument: () => ({ ...readable.getDocument(), destroy }),
    };
    await countPagesWithoutText(new ArrayBuffer(8));
    expect(destroy).toHaveBeenCalledTimes(1);

    (globalThis as { __fakePdf?: unknown }).__fakePdf = {
      getDocument: () => ({
        promise: Promise.reject(new Error("bad pdf")),
        destroy,
      }),
    };
    await extractPdfText(new ArrayBuffer(8));
    expect(destroy).toHaveBeenCalledTimes(2);
  });
});
