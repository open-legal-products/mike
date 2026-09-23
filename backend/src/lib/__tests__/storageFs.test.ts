import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

// STORAGE_DRIVER / STORAGE_FS_ROOT are captured at module load in ../storage,
// so each case configures process.env BEFORE importing a fresh copy (same
// reset-then-dynamic-import pattern as storagePresign.test.ts).
async function loadFsStorage(root: string) {
  vi.resetModules();
  process.env.STORAGE_DRIVER = "fs";
  process.env.STORAGE_FS_ROOT = root;
  process.env.DOWNLOAD_SIGNING_SECRET = "test-signing-secret";
  process.env.BACKEND_PUBLIC_URL = "http://localhost:3001";
  delete process.env.R2_ENDPOINT_URL;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  return import("../storage");
}

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mike-storage-fs-"));
});

afterEach(async () => {
  delete process.env.STORAGE_DRIVER;
  delete process.env.STORAGE_FS_ROOT;
  delete process.env.BACKEND_PUBLIC_URL;
  await fs.rm(root, { recursive: true, force: true });
});

describe("filesystem storage driver", () => {
  it("is enabled by STORAGE_DRIVER=fs without any R2 config", async () => {
    const { storageEnabled } = await loadFsStorage(root);
    expect(storageEnabled).toBe(true);
  });

  it("round-trips upload → download → delete", async () => {
    const storage = await loadFsStorage(root);
    const key = "documents/u1/d1/source.pdf";
    const content = new TextEncoder().encode("pdf bytes").buffer as ArrayBuffer;

    await storage.uploadFile(key, content, "application/pdf");
    const back = await storage.downloadFile(key);
    expect(back).not.toBeNull();
    expect(Buffer.from(back!).toString()).toBe("pdf bytes");

    await storage.deleteFile(key);
    expect(await storage.downloadFile(key)).toBeNull();
  });

  it("deleteFile tolerates a missing key (S3 delete semantics)", async () => {
    const storage = await loadFsStorage(root);
    await expect(storage.deleteFile("documents/u1/gone.bin")).resolves
      .toBeUndefined();
  });

  it("listFiles matches S3 string-prefix semantics, not directories", async () => {
    const storage = await loadFsStorage(root);
    const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
    await storage.uploadFile("documents/u1/d1/source.pdf", enc("a"), "x");
    await storage.uploadFile("documents/u1/d1/versions/v1.docx", enc("b"), "x");
    await storage.uploadFile("documents/u1/d2/source.pdf", enc("c"), "x");
    await storage.uploadFile("generated/u1/d1/generated.docx", enc("d"), "x");

    // Whole-directory prefix
    expect(await storage.listFiles("documents/u1/d1/")).toEqual([
      "documents/u1/d1/source.pdf",
      "documents/u1/d1/versions/v1.docx",
    ]);
    // Partial-segment prefix must match d1 AND d2, like S3 would
    expect(await storage.listFiles("documents/u1/d")).toEqual([
      "documents/u1/d1/source.pdf",
      "documents/u1/d1/versions/v1.docx",
      "documents/u1/d2/source.pdf",
    ]);
    expect(await storage.listFiles("nope/")).toEqual([]);
  });

  it("getSignedUrl returns an expiring blob-token URL on the backend", async () => {
    const storage = await loadFsStorage(root);
    const url = await storage.getSignedUrl(
      "documents/u1/d1/source.pdf",
      3600,
      "Contract v2.pdf",
    );
    expect(url).toMatch(
      /^http:\/\/localhost:3001\/download\/signed\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    );

    const { verifyBlobToken } = await import("../downloadTokens");
    const token = url!.split("/download/signed/")[1];
    expect(verifyBlobToken(token)).toEqual({
      path: "documents/u1/d1/source.pdf",
      filename: "Contract v2.pdf",
    });
  });

  it("headFile reports size for a stored key and null for a missing one", async () => {
    const storage = await loadFsStorage(root);
    const key = "uploads/s1/f1.bin";
    await storage.uploadFile(
      key,
      new TextEncoder().encode("0123456789").buffer as ArrayBuffer,
      "application/octet-stream",
    );
    // The upload-session flow HEADs every staged object to confirm the browser
    // really sent the bytes it declared, so the fs driver has to answer too.
    expect(await storage.headFile(key)).toEqual({
      size: 10,
      etag: null,
      contentType: null,
    });
    expect(await storage.headFile("uploads/s1/never.bin")).toBeNull();
  });

  it("copyFile duplicates an object into a new nested key", async () => {
    const storage = await loadFsStorage(root);
    await storage.uploadFile(
      "documents/u1/d1/source.pdf",
      new TextEncoder().encode("original").buffer as ArrayBuffer,
      "application/pdf",
    );
    await storage.copyFile(
      "documents/u1/d1/source.pdf",
      "documents/u1/d2/copied.pdf",
    );
    const copied = await storage.downloadFile("documents/u1/d2/copied.pdf");
    expect(Buffer.from(copied!).toString()).toBe("original");
  });

  it("uploadFileFromPath stores a file already on disk", async () => {
    const storage = await loadFsStorage(root);
    const scratch = path.join(root, "scratch.pdf");
    await fs.writeFile(scratch, "generated pdf");
    await storage.uploadFileFromPath(
      "documents/u1/d1/generated.pdf",
      scratch,
      "application/pdf",
    );
    const back = await storage.downloadFile("documents/u1/d1/generated.pdf");
    expect(Buffer.from(back!).toString()).toBe("generated pdf");
  });

  it("createFileReadStream streams a stored object", async () => {
    const storage = await loadFsStorage(root);
    const key = "documents/u1/d1/source.pdf";
    await storage.uploadFile(
      key,
      new TextEncoder().encode("streamed bytes").buffer as ArrayBuffer,
      "application/pdf",
    );
    // main's zip export and raw-file download both consume this stream, so a
    // missing fs branch would have broken every download in local mode.
    const chunks: Buffer[] = [];
    for await (const chunk of storage.createFileReadStream(key)) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    expect(Buffer.concat(chunks).toString()).toBe("streamed bytes");
  });

  it("getSignedUploadUrl mints a redeemable PUT capability", async () => {
    const storage = await loadFsStorage(root);
    const url = await storage.getSignedUploadUrl(
      "uploads/s1/f1.pdf",
      "application/pdf",
      5,
      900,
    );
    expect(url).toMatch(
      /^http:\/\/localhost:3001\/download\/signed\/[\w-]+\.[\w-]+$/,
    );
    const token = url!.split("/").pop()!;
    const { verifyBlobUploadToken, verifyBlobToken } = await import(
      "../downloadTokens"
    );
    expect(verifyBlobUploadToken(token)).toEqual({
      path: "uploads/s1/f1.pdf",
      contentType: "application/pdf",
      sizeBytes: 5,
    });
    // Same route, different HMAC domain: a write capability must never be
    // spendable as a read capability.
    expect(verifyBlobToken(token)).toBeNull();
  });

  it("writeBlobFromStream persists the streamed body and reports its size", async () => {
    const storage = await loadFsStorage(root);
    const { Readable } = await import("node:stream");
    const written = await storage.writeBlobFromStream(
      "uploads/s1/f1.pdf",
      Readable.from([Buffer.from("abc"), Buffer.from("de")]),
      5,
    );
    expect(written).toBe(5);
    const back = await storage.downloadFile("uploads/s1/f1.pdf");
    expect(Buffer.from(back!).toString()).toBe("abcde");

    await storage.discardBlob("uploads/s1/f1.pdf");
    expect(await storage.downloadFile("uploads/s1/f1.pdf")).toBeNull();
  });

  it("rejects an oversized stream before it ends without writing beyond the signed limit", async () => {
    const storage = await loadFsStorage(root);
    const { PassThrough } = await import("node:stream");
    const body = new PassThrough();
    const writing = storage.writeBlobFromStream("uploads/s1/bounded.pdf", body, 4);
    body.write(Buffer.from("abc"));
    body.write(Buffer.from("defgh"));

    // A client need not finish its request for the bound to take effect.
    // Checking only the final byte count would hang here and write all bytes.
    await expect(writing).rejects.toBeInstanceOf(storage.BlobUploadSizeError);
    expect((await fs.stat(path.join(root, "uploads/s1/bounded.pdf"))).size).toBeLessThanOrEqual(4);
    expect(body.destroyed).toBe(false);
    body.end();
  });

  it("does not hang when an upload source disconnects before streaming starts", async () => {
    const storage = await loadFsStorage(root);
    const { PassThrough } = await import("node:stream");
    const body = new PassThrough();
    body.destroy();
    await expect(
      storage.writeBlobFromStream("uploads/s1/aborted.pdf", body, 5),
    ).rejects.toThrow("Upload aborted");
  });

  it("rejects keys that escape the storage root", async () => {
    const storage = await loadFsStorage(root);
    await expect(
      storage.uploadFile(
        "../outside.bin",
        new ArrayBuffer(1),
        "application/octet-stream",
      ),
    ).rejects.toThrow(/escapes STORAGE_FS_ROOT/);
  });

  // Containment is the fs driver's whole security boundary: a key is
  // attacker-influenced text (it carries a user-supplied filename), and
  // path.join would silently *canonicalize* "../" into a real escape rather
  // than refuse it. Pin the property from both sides so a future refactor of
  // fsPathFor cannot quietly widen it.
  describe("storage-root containment", () => {
    const escapes = {
      "parent traversal": "../outside.bin",
      "deep traversal": "documents/u1/../../../../../../etc/passwd",
      "traversal that ends up back inside is still a traversal attempt":
        "documents/../../mike-storage-fs-elsewhere/x.bin",
      "absolute key ignores the root entirely": "/etc/passwd",
    };

    for (const [name, key] of Object.entries(escapes)) {
      it(`rejects ${name}`, async () => {
        const storage = await loadFsStorage(root);
        const bytes = new ArrayBuffer(1);
        await expect(
          storage.uploadFile(key, bytes, "application/octet-stream"),
        ).rejects.toThrow(/escapes STORAGE_FS_ROOT/);
        // Every fs entry point shares the one choke-point, so none of them
        // may act on the key — but each surfaces the refusal in its own
        // driver-agnostic way. downloadFile reports "no such object" as null
        // (its S3 branch does the same), deleteFile propagates anything that
        // isn't a benign missing-file.
        await expect(storage.downloadFile(key)).resolves.toBeNull();
        await expect(storage.deleteFile(key)).rejects.toThrow(
          /escapes STORAGE_FS_ROOT/,
        );
      });
    }

    it("rejects a sibling directory that merely shares the root's prefix", async () => {
      // The classic off-by-one: "/tmp/mike-storage-fs-abc-evil" starts with
      // "/tmp/mike-storage-fs-abc", which is why the check compares against
      // root + path.sep rather than root.
      const storage = await loadFsStorage(root);
      const sibling = path.basename(root) + "-evil";
      await expect(
        storage.uploadFile(
          `../${sibling}/x.bin`,
          new ArrayBuffer(1),
          "application/octet-stream",
        ),
      ).rejects.toThrow(/escapes STORAGE_FS_ROOT/);
      await expect(fs.access(`${root}-evil`)).rejects.toThrow();
    });

    it("accepts a normal key and writes it inside the root", async () => {
      const storage = await loadFsStorage(root);
      const key = "documents/u1/d1/source.pdf";
      await storage.uploadFile(
        key,
        new TextEncoder().encode("inside").buffer as ArrayBuffer,
        "application/pdf",
      );
      const written = path.join(root, "documents", "u1", "d1", "source.pdf");
      await expect(fs.readFile(written, "utf8")).resolves.toBe("inside");
      expect(path.resolve(written).startsWith(path.resolve(root) + path.sep))
        .toBe(true);
    });
  });
});

describe("blob tokens", () => {
  it("expired tokens verify as null", async () => {
    await loadFsStorage(root);
    const { signBlobToken, verifyBlobToken } = await import("../downloadTokens");
    const token = signBlobToken("documents/u1/d1/source.pdf", "a.pdf", -5);
    expect(verifyBlobToken(token)).toBeNull();
  });

  it("blob and permanent download tokens are not interchangeable", async () => {
    await loadFsStorage(root);
    const { signBlobToken, signDownload, verifyBlobToken, verifyDownload } =
      await import("../downloadTokens");
    // A permanent token must not pass the blob verifier (it has no expiry),
    // and a blob token must not pass the permanent verifier — the HMACs are
    // domain-separated so one capability can't be replayed as the other.
    expect(verifyBlobToken(signDownload("p", "f"))).toBeNull();
    expect(verifyDownload(signBlobToken("p", "f", 60))).toBeNull();
  });
});
