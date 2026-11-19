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

/**
 * The one exact-match rule for a provider that verifies quotes verbatim: the
 * quote, as the model wrote it, occurs in the canonical text. No whitespace or
 * punctuation tolerance, so a changed legal quotation never passes.
 */
export function quoteOccursVerbatim(text: string, quote: string): boolean {
  return !!quote.trim() && text.includes(quote);
}

/**
 * Appended to a connector result that carried citable sources, given their
 * handles in the order the result lists the documents. Only handles are
 * named: titles are provider text and stay inside the fenced result.
 */
export function externalSourceCitationHint(
  handles: readonly string[],
  truncated: boolean | undefined,
): string {
  const quoted = handles.map((handle) => `"${handle}"`);
  if (quoted.length === 1) {
    let hint = `\n\nThis result is a complete source document, available in this chat as doc_id ${quoted[0]}. Cite it with that doc_id and quotes copied exactly from its text.`;
    if (truncated) {
      hint += ` The result above was cut off before the end of the document. Call read_document with doc_id ${quoted[0]} to read the full text before relying on or quoting any part not shown above.`;
    }
    return hint;
  }
  const list = `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
  let hint = `\n\nThis result contains ${quoted.length} complete source documents, available in this chat as doc_id ${list}, in the order they appear above. Cite each with its own doc_id and quotes copied exactly from its text.`;
  if (truncated) {
    hint += " The result above was cut off before the end. Call read_document with a document's doc_id to read its full text before relying on or quoting any part not shown above.";
  }
  return hint;
}

const REFERENCE_NOTE =
  "Source text is not stored; it is read again from the provider when the source is opened.";

/**
 * What is kept in place of external sources' text wherever a tool result is
 * persisted (a subagent's transcript, an approval's stored result): their
 * references only, under `external_source` for one source and
 * `external_sources` for several. The text stays in memory for the request
 * and is read again from the provider when a source is opened.
 */
export function externalSourceReference(
  sources: readonly { document: SourceDocument; handle?: string }[],
): string {
  const references = sources.map(({ document, handle }) => ({
    document_id: document.document_id,
    title: document.title,
    ...(handle ? { doc_id: handle } : {}),
  }));
  return JSON.stringify(
    references.length === 1
      ? { ok: true, external_source: { ...references[0], note: REFERENCE_NOTE } }
      : { ok: true, external_sources: references, note: REFERENCE_NOTE },
  );
}
