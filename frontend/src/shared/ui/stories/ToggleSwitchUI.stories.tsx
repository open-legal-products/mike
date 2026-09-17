import { useState } from "react";
import { ToggleSwitchUI } from "@/shared/ui/ToggleSwitchUI";

const meta = { title: "Shared UI / ToggleSwitch" };
export default meta;

/**
 * `role="switch"` + `aria-checked`, so the state is not carried by colour
 * alone. The off-state track has a contrasting boundary so it remains visible
 * against a white surface (WCAG 1.4.11).
 */
export const Interactive = () => {
    const [enabled, setEnabled] = useState(false);

    return (
        <ToggleSwitchUI checked={enabled} onCheckedChange={setEnabled}>
            Include exhibits in export
        </ToggleSwitchUI>
    );
};

export const States = () => (
    <div className="flex flex-col gap-4">
        <ToggleSwitchUI checked={false} onCheckedChange={() => {}}>
            Off
        </ToggleSwitchUI>
        <ToggleSwitchUI checked onCheckedChange={() => {}}>
            On
        </ToggleSwitchUI>
        <ToggleSwitchUI checked={false} onCheckedChange={() => {}} disabled>
            Disabled
        </ToggleSwitchUI>
    </div>
);

/** The label is optional; without children the switch is the whole control. */
export const WithoutLabel = () => {
    const [enabled, setEnabled] = useState(true);

    return (
        <ToggleSwitchUI
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label="Include exhibits in export"
        />
    );
};
