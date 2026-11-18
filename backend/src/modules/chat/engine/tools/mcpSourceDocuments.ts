import type { LegalDataHunterSource } from "../../../../lib/mcp/sourceDocuments";
import type { DocIndex, DocStore } from "../types";

/** Register only in this request; no source table, storage object, or cache. */
export function registerMcpLegalSource(
  source: LegalDataHunterSource,
  docIndex: DocIndex,
  docStore: DocStore,
): string {
  let handle = Object.entries(docIndex).find(
    ([, document]) => document.document_id === source.document.document_id,
  )?.[0];
  if (!handle) {
    let index = Object.keys(docIndex).length;
    while (docIndex[`doc-${index}`] || docStore.has(`doc-${index}`)) index++;
    handle = `doc-${index}`;
  }
  docIndex[handle] = {
    document_id: source.document.document_id,
    filename: source.document.title,
  };
  docStore.set(handle, {
    storage_path: "",
    file_type: "text/plain",
    filename: source.document.title,
    inline_text: source.text,
    panel_document: source.document,
  });
  return handle;
}
