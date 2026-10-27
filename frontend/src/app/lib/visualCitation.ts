import type { DocumentCitation } from "@/app/components/shared/types";
import { isVisualCiteTarget, type VisualCite } from "@/shared/lib/visualBridge";

/**
 * The citation a visual's click opens, in the shape the chat's citation path
 * already resolves. "active" and anything that is not a document uuid give
 * null: the web app has no active document to point at.
 */
export function citationFromVisualCite(
    cite: VisualCite,
    filename = "",
): DocumentCitation | null {
    if (cite.cite === "active" || !isVisualCiteTarget(cite.cite)) return null;
    const page =
        cite.page && /^\d+$/.test(cite.page) ? Number(cite.page) : (cite.page ?? "");
    const quote = cite.quote ?? "";
    return {
        type: "citation_data",
        kind: "document",
        ref: 0,
        doc_id: cite.cite,
        document_id: cite.cite,
        version_id: cite.version ?? null,
        filename,
        page,
        quote,
        ...(cite.sheet ? { sheet: cite.sheet } : {}),
        ...(cite.cell ? { cell: cite.cell } : {}),
        quotes: quote
            ? [
                  {
                      page,
                      quote,
                      ...(cite.sheet ? { sheet: cite.sheet } : {}),
                      ...(cite.cell ? { cell: cite.cell } : {}),
                  },
              ]
            : [],
    };
}
