import { ArrowRight, Download } from "lucide-react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

const meta = { title: "Shared UI / PillButton" };
export default meta;

export const Tones = () => (
    <div className="flex flex-wrap items-center gap-3">
        <PillButtonUI tone="black">Black</PillButtonUI>
        <PillButtonUI tone="white">White</PillButtonUI>
        <PillButtonUI tone="blue">Blue</PillButtonUI>
        <PillButtonUI tone="danger">Danger</PillButtonUI>
    </div>
);

export const SizesAndStates = () => (
    <div className="flex flex-wrap items-center gap-3">
        <PillButtonUI tone="blue" size="xs">
            Extra small
        </PillButtonUI>
        <PillButtonUI tone="blue" size="sm">
            Small
        </PillButtonUI>
        <PillButtonUI tone="blue" size="normal">
            Continue <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </PillButtonUI>
        <PillButtonUI
            tone="white"
            size="icon-xs"
            aria-label="Download"
        >
            <Download aria-hidden="true" className="h-3 w-3" />
        </PillButtonUI>
        <PillButtonUI tone="white" disabled>
            Disabled
        </PillButtonUI>
        <PillButtonUI tone="black" loading>
            Saving
        </PillButtonUI>
    </div>
);
