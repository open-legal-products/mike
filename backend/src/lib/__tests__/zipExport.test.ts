import { Readable } from "node:stream";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_ZIP_EXPORT_BYTES,
  MAX_ZIP_EXPORT_DOCUMENTS,
  uniqueArchiveFilename,
  zipExportLimitDetail,
} from "../zipExport";

describe("ZIP export limits", () => {
  it("accepts exports at the configured limits", () => {
    expect(
      zipExportLimitDetail(MAX_ZIP_EXPORT_DOCUMENTS, MAX_ZIP_EXPORT_BYTES),
    ).toBeNull();
  });

  it("rejects excessive document counts and total bytes", () => {
    expect(zipExportLimitDetail(MAX_ZIP_EXPORT_DOCUMENTS + 1, 0)).toMatch(
      /at most 200 documents/i,
    );
    expect(zipExportLimitDetail(1, MAX_ZIP_EXPORT_BYTES + 1)).toMatch(
      /at most 2 GB/i,
    );
  });

  it("keeps documents with duplicate filenames as separate archive entries", () => {
    const usedNames = new Set<string>();

    expect(uniqueArchiveFilename("Contract.pdf", usedNames)).toBe(
      "Contract.pdf",
    );
    expect(uniqueArchiveFilename("Contract.pdf", usedNames)).toBe(
      "Contract (2).pdf",
    );
    expect(uniqueArchiveFilename("Contract.pdf", usedNames)).toBe(
      "Contract (3).pdf",
    );
  });

  it("consumes streamed ZIP entries one at a time", async () => {
    let firstStarted = false;
    let secondStarted = false;
    let releaseFirst = () => {};
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = Readable.from(
      (async function* () {
        firstStarted = true;
        await firstBlocked;
        yield Buffer.from("first");
      })(),
    );
    const second = Readable.from(
      (async function* () {
        secondStarted = true;
        yield Buffer.from("second");
      })(),
    );
    const zip = new JSZip();
    zip.file("first.txt", first);
    zip.file("second.txt", second);
    const archive = zip.generateNodeStream({
      type: "nodebuffer",
      streamFiles: true,
      compression: "STORE",
    });
    const output: Buffer[] = [];
    const completed = new Promise<void>((resolve, reject) => {
      archive
        .on("data", (chunk) => output.push(Buffer.from(chunk)))
        .once("error", reject)
        .once("end", resolve);
    });

    await vi.waitFor(() => expect(firstStarted).toBe(true));
    expect(secondStarted).toBe(false);
    releaseFirst();
    await completed;

    expect(secondStarted).toBe(true);
    const generated = await JSZip.loadAsync(Buffer.concat(output));
    await expect(generated.file("first.txt")?.async("text")).resolves.toBe(
      "first",
    );
    await expect(generated.file("second.txt")?.async("text")).resolves.toBe(
      "second",
    );
  });
});
