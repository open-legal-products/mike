import { useState } from "react";
import type { Story } from "@ladle/react";
import { ToggleSwitch } from "@/app/components/ui/toggle-switch";

const meta = { title: "UI / ToggleSwitch" };
export default meta;

/**
 * `role="switch"` + `aria-checked`, so the state is not carried by colour
 * alone. The off-state track keeps a `bg-gray-300` fill to clear the 3:1
 * non-text contrast bar (WCAG 1.4.11).
 */
export const Interactive: Story = () => {
    const [enabled, setEnabled] = useState(false);

    return (
        <ToggleSwitch checked={enabled} onCheckedChange={setEnabled}>
            Include exhibits in export
        </ToggleSwitch>
    );
};

export const States: Story = () => (
    <div className="flex flex-col gap-4">
        <ToggleSwitch checked={false} onCheckedChange={() => {}}>
            Off
        </ToggleSwitch>
        <ToggleSwitch checked onCheckedChange={() => {}}>
            On
        </ToggleSwitch>
        <ToggleSwitch checked={false} onCheckedChange={() => {}} disabled>
            Disabled
        </ToggleSwitch>
    </div>
);

/** The label is optional; without children the switch is the whole control. */
export const WithoutLabel: Story = () => {
    const [enabled, setEnabled] = useState(true);

    return (
        <ToggleSwitch
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label="Include exhibits in export"
        />
    );
};
