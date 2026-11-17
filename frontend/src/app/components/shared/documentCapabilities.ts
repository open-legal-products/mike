import type { PanelDocument, PanelDocumentType } from "./types";

/**
 * Source types read from a provider (CourtListener case law; Legal Data
 * Hunter case law, legislation and legal research) rather than uploaded to
 * Mike. The web app treats every such document the
 * same way: no permissions, versions, editing, renaming or file download; a
 * text view instead of a file viewer; and a body that may have to be read from
 * the provider when the document opens. Adding a provider type here is the
 * whole of its frontend integration.
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

/** The legal-source icon for a document type, or null for file types. */
export function legalSourceIconKind(
    type: string | null | undefined,
): LegalSourceIconKind | null {
    if (type === "case" || type === "legislation") return type;
    // Legal research (doctrine, commentary) shares the legislation glyph.
    return type === "legal_research" ? "legislation" : null;
}

export type DocumentCapabilities = {
    /** Read from a provider, not uploaded: see EXTERNAL_SOURCE_TYPES. */
    external: boolean;
    /**
     * The document has no body yet: a citation carries only the reference and
     * the panel reads the text from the provider when it opens.
     */
    hydrateOnOpen: boolean;
    legalIcon: LegalSourceIconKind | null;
};

export function documentCapabilities(document: PanelDocument): DocumentCapabilities {
    const external = isExternalSourceType(document.type);
    return {
        external,
        hydrateOnOpen:
            external &&
            !document.subdocuments?.some(
                (subdocument) => !!subdocument.html || !!subdocument.text,
            ),
        legalIcon: legalSourceIconKind(document.type),
    };
}
