import type { PanelDocument, PanelDocumentType } from "./types";

/**
 * A document read from a provider (CourtListener case law; Legal Data Hunter
 * case law, legislation and legal research) rather than uploaded to Mike
 * says so on the wire (`SourceDocument.provider`). The web app treats every
 * such document the same way: no permissions, versions, editing, renaming or
 * file download; a text view instead of a file viewer; and a body that may
 * have to be read from the provider when the document opens. Documents saved
 * before the field existed, and the client's own reconstruction of a case
 * citation, are recognised by these types, which no upload ever has. Adding
 * a provider needs no frontend change unless it introduces a new
 * `SourceDocumentType`, which goes into the contract's union, `PANEL_DOCUMENT_TYPES`,
 * this set and `legalSourceIconKind`.
 */
const EXTERNAL_SOURCE_TYPES: ReadonlySet<string> = new Set<PanelDocumentType>([
    "case",
    "legislation",
    "legal_research",
]);

export type LegalSourceIconKind = "case" | "legislation";

export function isExternalSourceType(type: string | null | undefined): boolean {
    return !!type && EXTERNAL_SOURCE_TYPES.has(type);
}

/** Whether a panel document (if any) was read from a provider rather than uploaded. */
export function isExternalSourceDocument(document: PanelDocument | null | undefined): boolean {
    return !!document && documentCapabilities(document).external;
}

/** The legal-source icon for a document type, or null for file types. */
export function legalSourceIconKind(
    type: string | null | undefined,
): LegalSourceIconKind | null {
    if (type === "case" || type === "legislation") return type;
    // Legal research (doctrine, commentary) shares the legislation glyph.
    return type === "legal_research" ? "legislation" : null;
}

export type DocumentCapabilities = {
    /** Read from a provider, not uploaded. */
    external: boolean;
    /**
     * The document has no body yet: a citation carries only the reference and
     * the panel reads the text from the provider when it opens.
     */
    hydrateOnOpen: boolean;
    /**
     * Quotes were verified verbatim against the provider's text, so they are
     * highlighted exactly; otherwise the tolerant letters-only match applies.
     */
    exactQuotes: boolean;
    legalIcon: LegalSourceIconKind | null;
};

export function documentCapabilities(document: PanelDocument): DocumentCapabilities {
    const external = !!document.provider || isExternalSourceType(document.type);
    return {
        external,
        hydrateOnOpen:
            external &&
            !document.subdocuments?.some(
                (subdocument) => !!subdocument.html || !!subdocument.text,
            ),
        // LDH citations saved before provider stamps used the reserved mcp:
        // namespace and already required verbatim quotes. Preserve that
        // behavior only for legacy documents; an explicit policy wins.
        exactQuotes: document.quote_verification === "exact" ||
            (document.quote_verification === undefined && !document.provider &&
                external && document.document_id.startsWith("mcp:")),
        legalIcon: legalSourceIconKind(document.type),
    };
}
