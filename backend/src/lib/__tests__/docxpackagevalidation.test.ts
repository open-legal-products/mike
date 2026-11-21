import { afterEach, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { Document, Packer, Paragraph } from "docx";
import { validateDocxPackage } from "../docxpackagevalidation";

afterEach(() => vi.restoreAllMocks());

it.each([
  ["[Content_Types].xml", 256 * 1024],
  ["_rels/.rels", 256 * 1024],
  ["word/document.xml", 100 * 1024 * 1024],
] as const)("retains the declared %s ceiling without decompressing the entry", async (part, ceiling) => {
  const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("Ordinary file")] }] }));
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file(part)!;
  const data = (entry as JSZip.JSZipObject & { _data: { uncompressedSize: number } })._data;
  data.uncompressedSize = ceiling + 1; // Metadata only; no large allocation or input.
  const stream = vi.spyOn(entry as JSZip.JSZipObject & { internalStream(type: string): unknown }, "internalStream").mockImplementation(() => { throw new Error("declared size was ignored"); });
  vi.spyOn(JSZip, "loadAsync").mockResolvedValueOnce(zip);
  await expect(validateDocxPackage(Uint8Array.from(bytes).buffer)).resolves.toBe(false);
  expect(stream).not.toHaveBeenCalled();
});

it.each(["", "not a ZIP", "PK\u0003\u0004truncated"])("returns false for known malformed archive bytes: %s", async (content) => {
  await expect(validateDocxPackage(new TextEncoder().encode(content).buffer)).resolves.toBe(false);
});

it.each([
  new RangeError("Array buffer allocation failed"),
  new Error("ENOMEM"),
  new Error("unexpected parser failure"),
])("does not classify infrastructure failures as malformed packages: %s", async (error) => {
  vi.spyOn(JSZip, "loadAsync").mockRejectedValueOnce(error);
  await expect(validateDocxPackage(new ArrayBuffer(0))).rejects.toBe(error);
});

it("preserves allocation failures emitted by a ZIP entry stream", async () => {
  const error = new RangeError("Invalid string length");
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  const stream = {
    on(name: string, listener: (...args: unknown[]) => void) { listeners[name] = listener; return stream; },
    resume() { listeners.error!(error); },
    pause() {},
  };
  vi.spyOn(JSZip, "loadAsync").mockResolvedValueOnce({
    file: () => ({ _data: { uncompressedSize: 1 }, internalStream: () => stream }),
  } as unknown as JSZip);
  await expect(validateDocxPackage(new ArrayBuffer(0))).rejects.toBe(error);
});

it("accepts a package whose entries use Windows backslash separators", async () => {
  const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("Old Word")] }] }));
  const source = await JSZip.loadAsync(bytes);
  const renamed = new JSZip();
  for (const entry of Object.values(source.files).filter((file) => !file.dir)) {
    renamed.file(entry.name.replaceAll("/", "\\"), await entry.async("nodebuffer"));
  }
  const archive = await renamed.generateAsync({ type: "uint8array" });
  expect(Object.keys((await JSZip.loadAsync(archive)).files)).toContain("word\\document.xml");
  await expect(validateDocxPackage(archive.slice().buffer)).resolves.toBe(true);
});
