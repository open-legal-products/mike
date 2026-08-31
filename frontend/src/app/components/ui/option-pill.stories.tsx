import { useState } from "react";
import type { Story } from "@ladle/react";
import { X } from "lucide-react";
import { OptionPill } from "@/app/components/ui/option-pill";

export default { title: "UI / OptionPill" };

/** A compact removable option, distinct from an action button. */
export const Default: Story = () => (
    <div className="flex flex-wrap items-center gap-2">
        <OptionPill>Contract</OptionPill>
        <OptionPill>Motion to dismiss</OptionPill>
        <OptionPill disabled>Disabled</OptionPill>
    </div>
);

export const Removable: Story = () => {
    const [options, setOptions] = useState([
        "Jurisdiction: NY",
        "Filed after 2020",
        "Redlined",
    ]);

    return (
        <div className="flex flex-wrap items-center gap-2">
            {options.map((option) => (
                <OptionPill
                    key={option}
                    aria-label={`Remove ${option}`}
                    onClick={() =>
                        setOptions((current) =>
                            current.filter((item) => item !== option),
                        )
                    }
                >
                    {option}
                    <X className="h-3 w-3" aria-hidden="true" />
                </OptionPill>
            ))}
            {options.length === 0 ? (
                <span className="text-xs text-gray-400">All removed.</span>
            ) : null}
        </div>
    );
};
