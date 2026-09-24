/** A revision can span several rendered runs or lines in SuperDoc. */
export function docxRevisionElements(
    root: Element,
    kind: "ins" | "del",
    id?: string | null,
    text?: string,
): HTMLElement[] {
    const selector = kind === "ins"
        ? '[data-track-change-kind="insert"]'
        : '[data-track-change-kind="delete"]';
    const candidates = Array.from(root.querySelectorAll<HTMLElement>(selector));
    const exact = id == null ? [] : candidates.filter(
        // The first imported ID identifies this run. Subsequent IDs can
        // include the opposite side of a grouped replacement.
        (element) => element.dataset.trackChangeIds?.split(",")[0] === `imported:${id}`,
    );
    if (exact.length) return exact;
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
    const target = normalize(text ?? "");
    if (!target) return [];
    const match = candidates.find((element) => normalize(element.textContent ?? "") === target)
        ?? candidates.find((element) => normalize(element.textContent ?? "").includes(target));
    return match ? [match] : [];
}
