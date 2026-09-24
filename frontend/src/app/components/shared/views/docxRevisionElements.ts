/** A revision can span several rendered runs or lines in EigenPal. */
export function docxRevisionElements(
    root: Element,
    kind: "ins" | "del",
    id?: string | null,
    text?: string,
): HTMLElement[] {
    const selector = kind === "ins"
        ? '[data-revision-kind="insert"]'
        : '[data-revision-kind="delete"]';
    const candidates = Array.from(root.querySelectorAll<HTMLElement>(selector));
    const exact = id == null ? [] : candidates.filter(
        (element) => element.dataset.revisionId === id,
    );
    if (exact.length) return exact;
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
    const target = normalize(text ?? "");
    if (!target) return [];
    const match = candidates.find((element) => normalize(element.textContent ?? "") === target)
        ?? candidates.find((element) => normalize(element.textContent ?? "").includes(target));
    return match ? [match] : [];
}
