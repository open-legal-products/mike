import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ getDocument: mocks.getDocument }));
import { countPagesWithoutText, extractPdfTextForIndex } from "../pdfText";
import { diagnosticErrorTags } from "../observability/sentryPrivacy";
afterEach(() => { vi.restoreAllMocks(); mocks.getDocument.mockReset(); });

function openedDocumentFailure() {
  const failure = new TypeError("Unexpected page processing failure");
  const destroy = vi.fn(async () => {});
  mocks.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 1, getPage: async () => { throw failure; } }), destroy });
  return { failure, destroy };
}

it("keeps page-processing failures separate from invalid PDF input in the strict reader", async () => {
  const { failure, destroy } = openedDocumentFailure();
  const thrown = await extractPdfTextForIndex(new ArrayBuffer(0)).catch((error: unknown) => error);
  expect(diagnosticErrorTags(thrown).error_kind).toBe("extraction.failed");
  expect((thrown as Error).cause).toMatchObject({ cause: failure });
  expect(destroy).toHaveBeenCalledOnce();
});

it("keeps the processing-failure kind when the lenient reader returns its fallback", async () => {
  const { destroy } = openedDocumentFailure();
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  await expect(countPagesWithoutText(new ArrayBuffer(0))).resolves.toBeNull();
  expect(log).toHaveBeenCalledOnce();
  const logged = log.mock.calls[0]![1] as { error: unknown };
  expect(diagnosticErrorTags(logged.error).error_kind).toBe("extraction.failed");
  expect(destroy).toHaveBeenCalledOnce();
});
