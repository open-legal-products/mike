/**
 * Corner rounding for a document view's frame. `"top-right"` keeps only the
 * corner facing a side panel's details column; the panel clips the rest.
 */
export type ViewRounding = boolean | "top-right";

export function viewRoundingClass(rounded: ViewRounding): string {
    if (rounded === "top-right") return "rounded-tr-lg";
    return rounded ? "rounded-lg" : "";
}
