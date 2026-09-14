import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StorageAdapter } from "../storage";

let storage: typeof import("../storage");

function fakeAdapter(overrides: Partial<StorageAdapter> = {}): StorageAdapter {
  return {
    enabled: true,
    configurationHint: "FAKE_STORAGE_URL must be set",
    uploadFile: vi.fn(async () => undefined),
    uploadFileFromPath: vi.fn(async () => undefined),
    getSignedUploadUrl: vi.fn(async () => "https://signed.example.test/put"),
    downloadFile: vi.fn(async () => new ArrayBuffer(4)),
    openReadStream: vi.fn(async () => [
      new Uint8Array([1, 2]),
      new Uint8Array([3]),
    ]),
    headFile: vi.fn(async () => ({
      size: 12,
      etag: '"abc"',
      contentType: "application/pdf",
    })),
    listFiles: vi.fn(async () => ["a", "b"]),
    copyFile: vi.fn(async () => undefined),
    deleteFile: vi.fn(async () => undefined),
    getSignedUrl: vi.fn(async () => "https://signed.example.test/object"),
    ...overrides,
  };
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

// The facade holds module-level adapter state, so re-import it fresh for each
// test instead of restoring the default S3 adapter by hand.
beforeEach(async () => {
  vi.resetModules();
  storage = await import("../storage");
});

afterEach(() => {
  vi.resetModules();
});

describe("setStorageAdapter", () => {
  it("routes every operation through the injected adapter", async () => {
    const adapter = fakeAdapter();
    storage.setStorageAdapter(adapter);

    const content = new ArrayBuffer(8);
    await storage.uploadFile("k", content, "application/pdf");
    expect(adapter.uploadFile).toHaveBeenCalledWith(
      "k",
      content,
      "application/pdf",
    );

    await storage.uploadFileFromPath("k", "/tmp/x.pdf", "application/pdf");
    expect(adapter.uploadFileFromPath).toHaveBeenCalledWith(
      "k",
      "/tmp/x.pdf",
      "application/pdf",
    );

    await expect(storage.downloadFile("k")).resolves.toBeInstanceOf(
      ArrayBuffer,
    );
    await expect(storage.listFiles("pre/")).resolves.toEqual(["a", "b"]);
    await expect(storage.headFile("k")).resolves.toEqual({
      size: 12,
      etag: '"abc"',
      contentType: "application/pdf",
    });

    await storage.copyFile("from", "to");
    expect(adapter.copyFile).toHaveBeenCalledWith("from", "to");

    await storage.deleteFile("k");
    expect(adapter.deleteFile).toHaveBeenCalledWith("k");
  });

  it("streams reads through the adapter, opening lazily", async () => {
    const adapter = fakeAdapter();
    storage.setStorageAdapter(adapter);

    const stream = storage.createFileReadStream("k");
    // Nothing is fetched until a consumer actually reads.
    expect(adapter.openReadStream).not.toHaveBeenCalled();

    await expect(collect(stream)).resolves.toEqual(Buffer.from([1, 2, 3]));
    expect(adapter.openReadStream).toHaveBeenCalledWith("k");
  });

  it("presigns uploads through the adapter with the declared size", async () => {
    const adapter = fakeAdapter();
    storage.setStorageAdapter(adapter);

    await expect(
      storage.getSignedUploadUrl("k", "application/pdf", 2048),
    ).resolves.toBe("https://signed.example.test/put");
    expect(adapter.getSignedUploadUrl).toHaveBeenCalledWith(
      "k",
      "application/pdf",
      2048,
      900,
    );
  });

  it("updates the live storageEnabled binding", () => {
    storage.setStorageAdapter(fakeAdapter({ enabled: true }));
    expect(storage.storageEnabled).toBe(true);
    storage.setStorageAdapter(fakeAdapter({ enabled: false }));
    expect(storage.storageEnabled).toBe(false);
  });

  it("builds the Content-Disposition header before the adapter sees it", async () => {
    const adapter = fakeAdapter();
    storage.setStorageAdapter(adapter);

    await storage.getSignedUrl("k", 60, "Contract v2.pdf");
    expect(adapter.getSignedUrl).toHaveBeenCalledWith(
      "k",
      60,
      `attachment; filename="Contract v2.pdf"; filename*=UTF-8''Contract%20v2.pdf`,
    );

    await storage.getSignedUrl("k", 60);
    expect(adapter.getSignedUrl).toHaveBeenLastCalledWith("k", 60, undefined);
  });
});

describe("not-configured degradation (shared policy)", () => {
  it("throws the adapter's configuration hint on upload", async () => {
    const adapter = fakeAdapter({ enabled: false });
    storage.setStorageAdapter(adapter);

    await expect(
      storage.uploadFile("k", new ArrayBuffer(1), "text/plain"),
    ).rejects.toThrow("FAKE_STORAGE_URL must be set");
    expect(adapter.uploadFile).not.toHaveBeenCalled();
  });

  it("fails closed for the operations that must not silently succeed", async () => {
    const adapter = fakeAdapter({ enabled: false });
    storage.setStorageAdapter(adapter);

    expect(() => storage.assertStorageConfigured()).toThrow(
      "FAKE_STORAGE_URL must be set",
    );
    await expect(
      storage.uploadFileFromPath("k", "/tmp/x", "text/plain"),
    ).rejects.toThrow("FAKE_STORAGE_URL must be set");
    await expect(storage.copyFile("a", "b")).rejects.toThrow(
      "FAKE_STORAGE_URL must be set",
    );
    expect(adapter.uploadFileFromPath).not.toHaveBeenCalled();
    expect(adapter.copyFile).not.toHaveBeenCalled();
  });

  it("returns null/empty for reads and skips deletes", async () => {
    const adapter = fakeAdapter({ enabled: false });
    storage.setStorageAdapter(adapter);

    await expect(storage.downloadFile("k")).resolves.toBeNull();
    await expect(storage.listFiles("pre/")).resolves.toEqual([]);
    await expect(storage.headFile("k")).resolves.toBeNull();
    await expect(storage.getSignedUrl("k")).resolves.toBeNull();
    await expect(
      storage.getSignedUploadUrl("k", "text/plain", 1),
    ).resolves.toBeNull();
    await expect(storage.deleteFile("k")).resolves.toBeUndefined();
    expect(adapter.downloadFile).not.toHaveBeenCalled();
    expect(adapter.headFile).not.toHaveBeenCalled();
    expect(adapter.deleteFile).not.toHaveBeenCalled();
  });

  it("logs and swallows adapter failures on download and signing", async () => {
    const adapter = fakeAdapter({
      downloadFile: vi.fn(async () => {
        throw new Error("boom");
      }),
      getSignedUrl: vi.fn(async () => {
        throw new Error("boom");
      }),
      getSignedUploadUrl: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    storage.setStorageAdapter(adapter);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(storage.downloadFile("k")).resolves.toBeNull();
    await expect(storage.getSignedUrl("k")).resolves.toBeNull();
    await expect(
      storage.getSignedUploadUrl("k", "text/plain", 1),
    ).resolves.toBeNull();
    expect(log).toHaveBeenCalledTimes(3);
    log.mockRestore();
  });

  it("wraps adapter failures callers are expected to catch", async () => {
    const adapter = fakeAdapter({
      uploadFileFromPath: vi.fn(async () => {
        throw new Error("boom");
      }),
      copyFile: vi.fn(async () => {
        throw new Error("boom");
      }),
      headFile: vi.fn(async () => {
        throw new Error("boom");
      }),
      openReadStream: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    storage.setStorageAdapter(adapter);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      storage.uploadFileFromPath("k", "/tmp/x", "text/plain"),
    ).rejects.toThrow("Object storage upload failed");
    await expect(storage.copyFile("a", "b")).rejects.toThrow(
      "Object storage copy failed",
    );
    await expect(storage.headFile("k")).rejects.toThrow(
      "Object storage HEAD failed",
    );
    await expect(collect(storage.createFileReadStream("k"))).rejects.toThrow(
      "Object storage download failed",
    );
    log.mockRestore();
  });

  it("treats a missing stream body as a download failure, not empty bytes", async () => {
    const adapter = fakeAdapter({ openReadStream: vi.fn(async () => null) });
    storage.setStorageAdapter(adapter);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(collect(storage.createFileReadStream("k"))).rejects.toThrow(
      "Object storage download failed",
    );
    log.mockRestore();
  });
});
