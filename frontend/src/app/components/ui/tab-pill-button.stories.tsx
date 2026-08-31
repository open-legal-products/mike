import { useState } from "react";
import type { Story } from "@ladle/react";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";

export default { title: "UI / TabPillButton" };

const FILTERS = ["All", "Drafts", "Filed", "Archived"];

/**
 * Segmented filter/tab pills. `active` maps straight onto `aria-pressed`, so
 * selection is exposed to assistive tech rather than living in colour alone.
 */
export const Segmented: Story = () => {
    const [selected, setSelected] = useState("All");

    return (
        <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map((filter) => (
                <TabPillButton
                    key={filter}
                    active={filter === selected}
                    onClick={() => setSelected(filter)}
                >
                    {filter}
                </TabPillButton>
            ))}
        </div>
    );
};

/**
 * Omitting `active` entirely is a third state: a neutral pill with no
 * `aria-pressed`, for a pill that is not part of a selected/unselected set.
 */
export const States: Story = () => (
    <div className="flex flex-wrap items-center gap-2">
        <TabPillButton active>Active</TabPillButton>
        <TabPillButton active={false}>Inactive</TabPillButton>
        <TabPillButton>Unset (no aria-pressed)</TabPillButton>
        <TabPillButton active={false} disabled>
            Disabled
        </TabPillButton>
    </div>
);
