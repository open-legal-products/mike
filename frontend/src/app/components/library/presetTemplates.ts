import catalog from "./presetTemplates.json";
import { uploadLibraryDocument } from "@/app/lib/mikeApi";
import type { Document, LibraryFolder } from "@/app/components/shared/types";

export type PresetTemplate = (typeof catalog)[number];
export const PRESET_TEMPLATES: readonly PresetTemplate[] = catalog;

export function presetTemplateUrl(preset: PresetTemplate): string {
  return `/preset-templates/${preset.id.split("/").map(encodeURIComponent).join("/")}`;
}

export async function addPresetTemplate(
  preset: PresetTemplate,
  folderId: string | null,
  signal: AbortSignal,
) {
  if (!isPresetDocument(preset)) {
    throw new Error("This reference file is available for download only.");
  }
  const response = await fetch(presetTemplateUrl(preset), { signal });
  if (!response.ok) throw new Error("Preset download failed");
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  if (bytes.byteLength !== preset.size || hash !== preset.sha256) {
    throw new Error("Preset integrity check failed");
  }
  signal.throwIfAborted();
  const file = new File([bytes], preset.filename, {
    type:
      preset.format === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  return uploadLibraryDocument("templates", file, folderId, { signal });
}

// The day the bundled snapshot was downloaded from the publishers; shown as
// the created/updated date of every preset row.
const PRESET_SNAPSHOT_DATE = "2026-09-30T00:00:00.000Z";
const PRESET_FOLDER_ID_PREFIX = "preset-folder:";

/** Markdown references cannot be rendered or stored as templates. */
export function isPresetDocument(preset: PresetTemplate): boolean {
  return preset.format === "docx" || preset.format === "pdf";
}

/**
 * The catalog as a document directory: each publisher's library is a
 * top-level folder and the publisher's own package directories nest below it.
 * Documents are keyed by their preset id.
 */
export function presetDirectory(): {
  documents: Document[];
  folders: LibraryFolder[];
} {
  const folders = new Map<string, LibraryFolder>();
  const folderIdFor = (path: string): string | null => {
    if (!path) return null;
    const id = `${PRESET_FOLDER_ID_PREFIX}${path}`;
    if (!folders.has(id)) {
      const segments = path.split("/");
      folders.set(id, {
        id,
        user_id: "",
        library_kind: "template",
        name: segments.at(-1)!,
        parent_folder_id: folderIdFor(segments.slice(0, -1).join("/")),
        created_at: PRESET_SNAPSHOT_DATE,
        updated_at: PRESET_SNAPSHOT_DATE,
      });
    }
    return id;
  };
  const documents = PRESET_TEMPLATES.map(
    (preset): Document => ({
      id: preset.id,
      project_id: null,
      folder_id: folderIdFor(preset.group),
      library_kind: "template",
      filename: preset.filename,
      file_type: preset.format,
      storage_path: null,
      pdf_storage_path: null,
      size_bytes: preset.size,
      page_count: null,
      structure_tree: null,
      status: "ready",
      created_at: PRESET_SNAPSHOT_DATE,
      updated_at: PRESET_SNAPSHOT_DATE,
    }),
  );
  return { documents, folders: [...folders.values()] };
}
