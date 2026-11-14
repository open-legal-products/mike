import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  uploadFile: vi.fn(async (_key: string, _bytes: ArrayBuffer, _type: string) => {}),
  docxToPdf: vi.fn(),
  enqueueConversion: vi.fn(async (_args: Record<string, unknown>) => ({})),
  generateImageBytes: vi.fn(),
  enabled: true,
}));

vi.mock("../../../../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../lib/storage")>()),
  uploadFile: (k: string, b: ArrayBuffer, t: string) => mocks.uploadFile(k, b, t),
}));
vi.mock("../../../../../lib/convert", () => ({
  docxToPdf: mocks.docxToPdf,
  convertedPdfKey: (u: string, d: string) => `converted-pdfs/${u}/${d}.pdf`,
}));
vi.mock("../../../../../lib/queue/conversionQueue", () => ({
  enqueueConversion: (a: Record<string, unknown>) => mocks.enqueueConversion(a),
}));
vi.mock("../../../../../lib/downloadTokens", () => ({
  buildDownloadUrl: () => "/download/test-token",
}));
vi.mock("../../../../../lib/imagegen/imageClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../lib/imagegen/imageClient")>()),
  readImageGenConfig: () => ({ enabled: mocks.enabled }),
  imageGenerationEnabled: (cfg: { enabled: boolean }) => cfg.enabled,
  generateImageBytes: (...args: unknown[]) => mocks.generateImageBytes(...args),
}));

import { AppError } from "../../../../../lib/appError";
import { generateImage } from "../documentOps";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function fakeDb() {
  return {
    rpc: vi.fn(async () => ({ data: { id: "version-1", version_number: 1 }, error: null })),
    from() {
      const q: Record<string, unknown> = {};
      q.insert = vi.fn(() => q);
      q.select = vi.fn(() => q);
      q.single = vi.fn(async () => ({ data: { id: "doc-1" }, error: null }));
      return q;
    },
  };
}

describe("generateImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled = true;
  });

  it("stores the image as a generated PNG and queues its rendition", async () => {
    mocks.generateImageBytes.mockResolvedValue({ bytes: PNG, extension: "png", mimeType: "image/png" });
    const result = await generateImage("Timeline", "a timeline", "user-1", fakeDb() as never);
    expect(result).toMatchObject({ filename: "Timeline.png", document_id: "doc-1" });
    expect(mocks.uploadFile.mock.calls[0]![2]).toBe("image/png");
    expect(mocks.docxToPdf).not.toHaveBeenCalled();
    expect(mocks.enqueueConversion).toHaveBeenCalledWith(
      expect.objectContaining({ fileType: "png", finalizeDocumentStatus: false }),
    );
  });

  it("answers with a configuration message when the feature is off", async () => {
    mocks.enabled = false;
    const result = await generateImage("x", "y", "user-1", fakeDb() as never);
    expect(result).toHaveProperty("error");
    expect(mocks.generateImageBytes).not.toHaveBeenCalled();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("returns a static error kind and stores nothing when the engine fails", async () => {
    mocks.generateImageBytes.mockRejectedValue(new AppError("image_generation.http_failed", "x"));
    const result = await generateImage("x", "y", "user-1", fakeDb() as never);
    expect(result).toMatchObject({ error_kind: "image_generation.http_failed" });
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("forwards the turn signal and stores nothing once the turn is stopped", async () => {
    const controller = new AbortController();
    mocks.generateImageBytes.mockImplementation(async () => {
      controller.abort();
      return { bytes: PNG, extension: "png", mimeType: "image/png" };
    });
    const result = await generateImage("x", "y", "user-1", fakeDb() as never, { signal: controller.signal });
    expect(mocks.generateImageBytes.mock.calls[0]![0]).toMatchObject({ signal: controller.signal });
    expect(result).toMatchObject({ error_kind: "image_generation.cancelled" });
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });
});
