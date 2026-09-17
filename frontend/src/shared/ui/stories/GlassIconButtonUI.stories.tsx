import { MoreHorizontal, X } from "lucide-react";
import { GlassIconButtonUI } from "@/shared/ui/GlassIconButtonUI";

const meta = { title: "Shared UI / GlassIconButton" };
export default meta;

export const Icons = () => (
    <div className="flex items-center gap-3">
        <GlassIconButtonUI aria-label="More options">
            <MoreHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
        </GlassIconButtonUI>
        <GlassIconButtonUI aria-label="Close">
            <X aria-hidden="true" className="h-3.5 w-3.5" />
        </GlassIconButtonUI>
        <GlassIconButtonUI aria-label="Disabled action" disabled>
            <MoreHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
        </GlassIconButtonUI>
    </div>
);
