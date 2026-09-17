import { useState } from "react";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";

const meta = { title: "Shared UI / TabPillButton" };
export default meta;

const FILTERS = ["All", "Drafts", "Filed", "Archived"];

/**
 * Segmented filter/tab pills. `active` maps straight onto `aria-pressed`, so
 * selection is exposed to assistive tech rather than living in colour alone.
 */
export const Segmented = () => {
    const [selected, setSelected] = useState("All");

    return (
        <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map((filter) => (
                <TabPillButtonUI
                    key={filter}
                    active={filter === selected}
                    onClick={() => setSelected(filter)}
                >
                    {filter}
                </TabPillButtonUI>
            ))}
        </div>
    );
};

/**
 * Omitting `active` entirely is a third state: a neutral pill with no
 * `aria-pressed`, for a pill that is not part of a selected/unselected set.
 */
export const States = () => (
    <div className="flex flex-wrap items-center gap-2">
        <TabPillButtonUI active>Active</TabPillButtonUI>
        <TabPillButtonUI active={false}>Inactive</TabPillButtonUI>
        <TabPillButtonUI>Unset (no aria-pressed)</TabPillButtonUI>
        <TabPillButtonUI active={false} disabled>
            Disabled
        </TabPillButtonUI>
    </div>
);
