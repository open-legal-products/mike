export function preprocessCitations<T extends { ref: number }>(
    text: string,
    citations: T[],
    inlineCitationTargets: T[],
): string {
    // Replace [N] or [N, M, ...] inline markers with internal §idx§ tokens backed by citations.
    return text.replace(/\[(\d+(?:,\s*\d+)*)\]/g, (full, refsStr) => {
        const refs = (refsStr as string)
            .split(",")
            .map((s: string) => parseInt(s.trim(), 10));
        // A group none of whose refs is cited stays as written: it may not be
        // a citation marker at all (a quote, a paragraph reference).
        if (!refs.some((ref) => citations.some((a) => a.ref === ref))) return full;
        // In a partly cited group, an uncited ref stays as text in its place.
        return refs
            .map((ref: number) => {
                const citation = citations.find((a) => a.ref === ref);
                if (!citation) return `[${ref}]`;
                const idx = inlineCitationTargets.length;
                inlineCitationTargets.push(citation);
                return `\`§${idx}§\`\u200B`;
            })
            .join("");
    });
}

// ---------------------------------------------------------------------------
// Markdown renderer (shared config)
// ---------------------------------------------------------------------------

export function internalCaseHref(
    value: string | number | null | undefined,
): string | null {
    if (typeof value === "number") return `us-case-${value}`;
    if (!value) return null;
    const match = value.match(/^us-case-(\d+)$/);
    return match ? `us-case-${match[1]}` : null;
}

