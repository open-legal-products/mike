import { beforeEach, describe, expect, it, vi } from "vitest";
const storage = vi.hoisted(() => ({
  copyFile: vi.fn(),
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
}));
vi.mock("../../../lib/storage", () => storage);
import { copyDocumentVersionFiles } from "../documents.copyFiles";
beforeEach(() => {
  vi.clearAllMocks();
  storage.copyFile.mockResolvedValue(undefined);
  storage.downloadFile.mockResolvedValue(null);
});
const base = {
  source: {
    storage_path: "source",
    file_type: "pdf",
    pdf_storage_path: "source",
  },
  storagePath: "copy",
  pdfStoragePath: "copy-pdf",
  transport: "server" as const,
  rendition: "required" as const,
};

describe("copying version objects", () => {
  it("copies a PDF's shared source/rendition only once", async () => {
    expect(await copyDocumentVersionFiles(base)).toEqual({
      pdfStoragePath: "copy",
    });
    expect(storage.copyFile).toHaveBeenCalledExactlyOnceWith("source", "copy");
  });
  it("tracks each prospective object before writing it for caller rollback", async () => {
    const writes: string[] = [];
    storage.copyFile.mockImplementation(async (_from, to) => {
      expect(writes).toContain(to);
    });
    await copyDocumentVersionFiles({
      ...base,
      source: { ...base.source, pdf_storage_path: "pdf" },
      beforeWrite: (key) => {
        writes.push(key);
      },
    });
    expect(writes).toEqual(["copy", "copy-pdf"]);
  });
  it("allows a missing optional rendition but retains the source", async () => {
    const bytes = new Uint8Array([1, 2]).buffer;
    expect(
      await copyDocumentVersionFiles({
        ...base,
        source: { ...base.source, pdf_storage_path: "missing" },
        transport: "download",
        rendition: "optional",
        sourceBytes: bytes,
      }),
    ).toEqual({ pdfStoragePath: null });
    expect(storage.uploadFile).toHaveBeenCalledWith(
      "copy",
      bytes,
      "application/pdf",
    );
  });
  it("fails a required rendition copy instead of reporting a complete asset", async () => {
    storage.copyFile
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("PDF unavailable"));
    await expect(
      copyDocumentVersionFiles({
        ...base,
        source: { ...base.source, pdf_storage_path: "missing" },
      }),
    ).rejects.toThrow("PDF unavailable");
  });
});
