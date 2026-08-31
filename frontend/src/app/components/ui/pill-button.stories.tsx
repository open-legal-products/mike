import type { Story } from "@ladle/react";
import { Plus } from "lucide-react";
import { PillButton } from "@/app/components/ui/pill-button";

const meta = { title: "UI / PillButton" };
export default meta;

/** The app's primary action button. Shared with the Word add-in via `PillButtonUI`. */
export const Tones: Story = () => (
    <div className="flex flex-wrap items-center gap-3">
        <PillButton tone="black">Black</PillButton>
        <PillButton tone="white">White</PillButton>
        <PillButton tone="blue">Blue</PillButton>
        <PillButton tone="danger">Danger</PillButton>
    </div>
);

export const Sizes: Story = () => (
    <div className="flex flex-wrap items-center gap-3">
        <PillButton tone="black" size="sm">
            Small (default)
        </PillButton>
        <PillButton tone="black" size="normal">
            Normal
        </PillButton>
    </div>
);

export const WithIcon: Story = () => (
    <PillButton tone="blue">
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        New document
    </PillButton>
);

export const Disabled: Story = () => (
    <div className="flex flex-wrap items-center gap-3">
        <PillButton tone="black" disabled>
            Black
        </PillButton>
        <PillButton tone="blue" disabled>
            Blue
        </PillButton>
    </div>
);
