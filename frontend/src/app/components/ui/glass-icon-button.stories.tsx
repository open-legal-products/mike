import type { Story } from "@ladle/react";
import { MoreHorizontal, PanelRightClose, X } from "lucide-react";
import { GlassIconButton } from "@/app/components/ui/glass-icon-button";

export default { title: "UI / GlassIconButton" };

/**
 * Circular glass icon button — modal close, panel dismiss. It is icon-only, so
 * `aria-label` is required by its type; the icon itself is `aria-hidden`.
 */
export const Default: Story = () => (
    <div className="flex flex-wrap items-center gap-3">
        <GlassIconButton aria-label="Close">
            <X className="h-3.5 w-3.5" aria-hidden="true" />
        </GlassIconButton>
        <GlassIconButton aria-label="Collapse panel">
            <PanelRightClose className="h-3.5 w-3.5" aria-hidden="true" />
        </GlassIconButton>
        <GlassIconButton aria-label="More actions">
            <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
        </GlassIconButton>
        <GlassIconButton aria-label="Close" disabled>
            <X className="h-3.5 w-3.5" aria-hidden="true" />
        </GlassIconButton>
    </div>
);
