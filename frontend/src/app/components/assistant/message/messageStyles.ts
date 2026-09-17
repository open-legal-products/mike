import { GLASS_CARD_SURFACE_CLASS } from "@/shared/ui/GlassCardUI";

export const RESPONSE_GLASS_SURFACE = GLASS_CARD_SURFACE_CLASS;

export function withoutMarkdownNode<P extends { node?: unknown }>(
    props: P,
): Omit<P, "node"> {
    const { node, ...rest } = props;
    void node;
    return rest;
}
