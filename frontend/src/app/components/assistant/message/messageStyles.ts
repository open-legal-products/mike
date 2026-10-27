import { LIQUID_GLASS_FLAT_CLASS } from "@mike/ui";

/**
 * Card surface for assistant response blocks, citation quotes, and tracked
 * changes. No backdrop blur: the flat material is an opaque fill, so the blur
 * never showed through while still costing a compositing layer per card.
 */
export const RESPONSE_GLASS_SURFACE = `rounded-xl ${LIQUID_GLASS_FLAT_CLASS}`;

export function withoutMarkdownNode<P extends { node?: unknown }>(
    props: P,
): Omit<P, "node"> {
    const { node, ...rest } = props;
    void node;
    return rest;
}
