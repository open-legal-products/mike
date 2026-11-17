// Provider-backed sources inside one assistant request.
//
// A connector tool can return a complete document (a judgment, a statute).
// The source-documents module recognises it; this file gives it a place in
// the request's document store so the model can read, search and cite it
// like an attachment. Nothing is persisted: citations carry the provider's
// document id and the panel reads the text again from the provider.

import type { ExternalSource, SourceDocument } from "../../../../lib/sourceDocuments";
import type { DocIndex, DocStore } from "../types";

/**
 * Registers a source for this request and returns its `doc-N` handle. A
 * source already registered under the same provider document id keeps its
 * handle, with the newer text.
 */
export function registerExternalSource(
  source: ExternalSource,
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
    external_source: source.document,
  });
  return handle;
}

/** Appended to a connector result that carried a citable source. */
export function externalSourceCitationHint(
  handle: string,
  truncated: boolean | undefined,
): string {
  let hint = `\n\nThis result is a complete source document, available in this chat as doc_id "${handle}". Cite it with that doc_id and quotes copied exactly from its text.`;
  if (truncated) {
    hint += ` The result above was cut off before the end of the document. Call read_document with doc_id "${handle}" to read the full text before relying on or quoting any part not shown above.`;
  }
  return hint;
}

/**
 * What is kept in place of an external source's text wherever a tool result
 * is persisted (a subagent's transcript, an approval's stored result): the
 * reference only. The text stays in memory for the request and is read again
 * from the provider when the source is opened.
 */
export function externalSourceReference(
  document: SourceDocument,
  handle?: string,
): string {
  return JSON.stringify({
    ok: true,
    external_source: {
      document_id: document.document_id,
      title: document.title,
      ...(handle ? { doc_id: handle } : {}),
      note: "Source text is not stored; it is read again from the provider when the source is opened.",
    },
  });
}
