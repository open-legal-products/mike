import { afterEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { Document, Packer, Paragraph } from "docx";
import JSZip from "jszip";
import { extractionCommand, runIsolatedExtraction, stopExtractionProcess } from "../isolated";
import { EXTRACTION_OPS } from "../ops";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

afterEach(async () => {
  await stopExtractionProcess();
  vi.unstubAllEnvs();
  vi.mocked(spawn).mockClear();
});

it("offers DOCX package validation through the existing parser operation table", () => {
  expect(EXTRACTION_OPS).toHaveProperty("validateDocxPackage", expect.any(Function));
});

it("retains the explicit isolation-off fallback without spawning a child", async () => {
  vi.stubEnv("EXTRACTION_ISOLATION", "off");
  const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("Ordinary synthetic Word file")] }] }));
  await expect(runIsolatedExtraction("validateDocxPackage", async () => Uint8Array.from(bytes).buffer)).resolves.toEqual({ text: "", valid: true });
  const zip = await JSZip.loadAsync(bytes);
  zip.file("word/document.xml", "<wrong/>");
  const invalid = await zip.generateAsync({ type: "uint8array" });
  await expect(runIsolatedExtraction("validateDocxPackage", async () => Uint8Array.from(invalid).buffer)).resolves.toEqual({ text: "", valid: false });
  expect(spawn).not.toHaveBeenCalled();
});

it.each(["darwin", "win32"])("constructs the existing heap-only command on %s (no Linux guarantee)", (platform) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { value: platform });
    vi.stubEnv("EXTRACTION_MAX_MEMORY_MB", "1024");
    const command = extractionCommand("process.js");
    expect(command).toEqual({ command: process.execPath, args: ["--disable-wasm-trap-handler", "--max-old-space-size=1024", "process.js"] });
  } finally { Object.defineProperty(process, "platform", descriptor); }
});
