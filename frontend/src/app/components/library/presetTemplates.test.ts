// @vitest-environment node
import { createHash, webcrypto } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addPresetTemplate,
  PRESET_TEMPLATES,
  presetDirectory,
  presetTemplateUrl,
} from "./presetTemplates";
import { uploadLibraryDocument } from "@/app/lib/mikeApi";

vi.mock("@/app/lib/mikeApi", () => ({ uploadLibraryDocument: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const root = join(process.cwd(), "public/preset-templates");

describe("bundled preset catalog", () => {
  it("accounts for every original file, with a unique id and matching checksum", () => {
    const files = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .map((entry) =>
        join(entry.parentPath, entry.name).slice(root.length + 1),
      );
    expect(PRESET_TEMPLATES.map((preset) => preset.id).sort()).toEqual(
      files.sort(),
    );
    expect(new Set(PRESET_TEMPLATES.map((preset) => preset.id)).size).toBe(
      files.length,
    );
    for (const preset of PRESET_TEMPLATES) {
      const bytes = readFileSync(join(root, preset.id));
      expect(bytes.length).toBe(preset.size);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        preset.sha256,
      );
      expect(preset.sourceUrl).toMatch(/^https:\/\//);
    }
  });

  it("files every preset under its publisher's folder, keeping package directories", () => {
    const { documents, folders } = presetDirectory();
    expect(documents.map((document) => document.id)).toEqual(
      PRESET_TEMPLATES.map((preset) => preset.id),
    );
    expect(
      folders
        .filter((folder) => folder.parent_folder_id === null)
        .map((folder) => folder.name)
        .sort(),
    ).toEqual(["Bonterms", "Common Paper", "General Legal"]);

    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    for (const document of documents) {
      const path = [document.filename];
      let folder = byId.get(document.folder_id ?? "");
      while (folder) {
        path.unshift(folder.name);
        folder = byId.get(folder.parent_folder_id ?? "");
      }
      expect(path.join("/")).toBe(document.id);
    }
  });

  it.each(["docx", "pdf"])(
    "uploads original %s bytes to the selected Templates folder",
    async (format) => {
      const preset = PRESET_TEMPLATES.find((item) => item.format === format)!;
      const bytes = readFileSync(join(root, preset.id));
      vi.stubGlobal("crypto", webcrypto);
      const fetchMock = vi
        .fn()
        .mockResolvedValue({
          ok: true,
          arrayBuffer: async () => Uint8Array.from(bytes).buffer,
        });
      vi.stubGlobal("fetch", fetchMock);
      const controller = new AbortController();
      vi.mocked(uploadLibraryDocument).mockResolvedValue({
        id: "personal-copy",
      } as never);
      expect(
        await addPresetTemplate(preset, "folder-1", controller.signal),
      ).toEqual({ id: "personal-copy" });
      expect(fetchMock).toHaveBeenCalledWith(presetTemplateUrl(preset), {
        signal: controller.signal,
      });
      expect(uploadLibraryDocument).toHaveBeenCalledWith(
        "templates",
        expect.any(File),
        "folder-1",
        { signal: controller.signal },
      );
      const file = vi.mocked(uploadLibraryDocument).mock.calls[0][1];
      expect(file.name).toBe(preset.filename);
      expect(file.size).toBe(bytes.length);
      const result = await file.arrayBuffer();
      expect(new Uint8Array(result)).toEqual(new Uint8Array(bytes));
    },
  );

  it("rejects an unavailable asset and a 200 response with corrupt bytes before upload", async () => {
    const preset = PRESET_TEMPLATES.find((item) => item.format === "docx")!;
    vi.stubGlobal("crypto", webcrypto);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(12),
      });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      addPresetTemplate(preset, null, new AbortController().signal),
    ).rejects.toThrow("download failed");
    await expect(
      addPresetTemplate(preset, null, new AbortController().signal),
    ).rejects.toThrow("integrity check failed");
    expect(uploadLibraryDocument).not.toHaveBeenCalled();
  });

  it("keeps Markdown reference files download-only", async () => {
    const preset = PRESET_TEMPLATES.find((item) => item.format === "md")!;
    await expect(
      addPresetTemplate(preset, null, new AbortController().signal),
    ).rejects.toThrow("download only");
    expect(uploadLibraryDocument).not.toHaveBeenCalled();
  });
});
