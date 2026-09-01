import { useState } from "react";
import type { Story } from "@ladle/react";
import { SearchBar } from "@/app/components/ui/search-bar";

const meta = { title: "UI / SearchBar" };
export default meta;

/** The clear button only appears once there is a value. */
export const Interactive: Story = () => {
    const [value, setValue] = useState("");

    return (
        <div className="max-w-sm">
            <SearchBar
                value={value}
                onValueChange={setValue}
                label="Search documents"
                placeholder="Search documents..."
            />
        </div>
    );
};

export const Sizes: Story = () => {
    const [small, setSmall] = useState("Deposition");
    const [normal, setNormal] = useState("Deposition");

    return (
        <div className="flex max-w-sm flex-col gap-4">
            <SearchBar
                size="sm"
                value={small}
                onValueChange={setSmall}
                label="Search (small)"
            />
            <SearchBar
                value={normal}
                onValueChange={setNormal}
                label="Search (normal)"
            />
        </div>
    );
};

/**
 * `label` is the accessible name — a placeholder alone is not one. It defaults
 * to "Search", so pass something specific when the page has more than one.
 */
export const LabelledForItsContext: Story = () => {
    const [value, setValue] = useState("");

    return (
        <div className="max-w-sm">
            <SearchBar
                value={value}
                onValueChange={setValue}
                label="Search matters"
                clearLabel="Clear matter search"
                placeholder="Search matters..."
            />
        </div>
    );
};
