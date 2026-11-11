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

  it("preserves path-like and normalized-collision document names as distinct leaf entries", async () => {
    const requested = [
      "Agreement.pdf", "../Agreement.pdf", "./Agreement.pdf",
      "folder/../Agreement.pdf", "folder\\..\\Agreement.pdf",
      "folder_.._Agreement.pdf", " .._Agreement.pdf ",
      "bad\u0000name.pdf", "bad_name.pdf",
    ];
    const expected = [
      "Agreement.pdf", ".._Agreement.pdf", "._Agreement.pdf",
      "folder_.._Agreement.pdf", "folder_.._Agreement (2).pdf",
      "folder_.._Agreement (3).pdf", ".._Agreement (2).pdf",
      "bad_name.pdf", "bad_name (2).pdf",
    ];
    const zip = new JSZip();
    const usedNames = new Set<string>();
    requested.forEach((name, index) => {
      zip.file(uniqueArchiveFilename(name, usedNames), `original-${index}`);
    });

    const reopened = await JSZip.loadAsync(await zip.generateAsync({ type: "nodebuffer" }));

    expect(Object.keys(reopened.files)).toEqual(expected);
    expect(Object.values(reopened.files).every(entry => !entry.dir)).toBe(true);
    for (const [index, name] of expected.entries()) {
      expect(await reopened.file(name)!.async("string")).toBe(`original-${index}`);
    }
  });

  it("preserves dot-only names and replacement-name collisions after reopening the archive", async () => {
    const requested = [".", "..", " . ", " .. ", "_", "_ (2)", "...", ".env"];
    const expected = ["_", "_ (2)", "_ (3)", "_ (4)", "_ (5)", "_ (2) (2)", "...", ".env"];
    const zip = new JSZip();
    const usedNames = new Set<string>();
    requested.forEach((name, index) => {
      zip.file(uniqueArchiveFilename(name, usedNames), `original-${index}`);
    });

    const reopened = await JSZip.loadAsync(await zip.generateAsync({ type: "nodebuffer" }));

    expect(Object.keys(reopened.files)).toEqual(expected);
    expect(Object.values(reopened.files).every(entry => !entry.dir)).toBe(true);
    for (const [index, name] of expected.entries()) {
      expect(await reopened.file(name)!.async("string")).toBe(`original-${index}`);
    }
  });

  it.each([
    ["case", "Agreement.pdf", "agreement.pdf", "agreement (2).pdf"],
    ["Unicode normalisation", "Résumé.pdf", "Résumé.pdf", "Résumé (2).pdf"],
  ])("suffixes names that differ only by %s, which extract to one file", async (_, first, second, suffixed) => {
    const usedNames = new Set<string>();
    const zip = new JSZip();
    zip.file(uniqueArchiveFilename(first, usedNames), "first");
    zip.file(uniqueArchiveFilename(second, usedNames), "second");

    const reopened = await JSZip.loadAsync(await zip.generateAsync({ type: "nodebuffer" }));

    expect(Object.keys(reopened.files)).toEqual([first, suffixed]);
    expect(await reopened.file(suffixed)!.async("string")).toBe("second");
  });

  it("writes a name nothing folds onto in its own case and Unicode form", () => {
    const usedNames = new Set<string>();

    expect(uniqueArchiveFilename("NDA - ACME.pdf", usedNames)).toBe("NDA - ACME.pdf");
    expect(uniqueArchiveFilename("Résumé.PDF", usedNames)).toBe("Résumé.PDF");
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
