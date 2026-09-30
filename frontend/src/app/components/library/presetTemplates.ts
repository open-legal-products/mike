import catalog from "./presetTemplates.json";
import { uploadLibraryDocument } from "@/app/lib/mikeApi";

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
  if (preset.format !== "docx" && preset.format !== "pdf") {
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
