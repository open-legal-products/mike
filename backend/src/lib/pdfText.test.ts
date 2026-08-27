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

import { extractPdfText } from "./pdfText";

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
