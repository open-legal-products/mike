import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
    Dropdown,
    DropdownAtPoint,
    DropdownButton,
    DropdownCheckboxItem,
    DropdownContent,
    DropdownItem,
    DropdownLabel,
    DropdownRadioGroup,
    DropdownRadioItem,
    DropdownSeparator,
    DropdownSurface,
    DropdownTrigger,
} from "@/shared/ui/dropdown";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

const meta = { title: "Shared UI / Dropdown" };
export default meta;

/** A menu opened from a button: the common case. */
export const Default = () => (
    <Dropdown>
        <DropdownTrigger asChild>
            <PillButtonUI tone="white">
                Actions <ChevronDown aria-hidden="true" className="h-3 w-3" />
            </PillButtonUI>
        </DropdownTrigger>
        <DropdownContent align="start" className="w-48">
            <DropdownLabel>Document</DropdownLabel>
            <DropdownItem>Rename</DropdownItem>
            <DropdownItem selected>Duplicate</DropdownItem>
            <DropdownItem disabled>Move to matter</DropdownItem>
            <DropdownSeparator />
            <DropdownItem variant="destructive">Delete</DropdownItem>
        </DropdownContent>
    </Dropdown>
);

export const CheckboxAndRadioItems = () => {
    const [showRedlines, setShowRedlines] = useState(true);
    const [showComments, setShowComments] = useState(false);
    const [sort, setSort] = useState("recent");

    return (
        <Dropdown>
            <DropdownTrigger asChild>
                <PillButtonUI tone="white">View options</PillButtonUI>
            </DropdownTrigger>
            <DropdownContent align="start" className="w-48">
                <DropdownLabel>Show</DropdownLabel>
                <DropdownCheckboxItem
                    checked={showRedlines}
                    onCheckedChange={setShowRedlines}
                >
                    Redlines
                </DropdownCheckboxItem>
                <DropdownCheckboxItem
                    checked={showComments}
                    onCheckedChange={setShowComments}
                >
                    Comments
                </DropdownCheckboxItem>
                <DropdownSeparator />
                <DropdownLabel>Sort by</DropdownLabel>
                <DropdownRadioGroup value={sort} onValueChange={setSort}>
                    <DropdownRadioItem value="recent">
                        Most recent
                    </DropdownRadioItem>
                    <DropdownRadioItem value="name">Name</DropdownRadioItem>
                </DropdownRadioGroup>
            </DropdownContent>
        </Dropdown>
    );
};

/** Right-click the area to open a menu at the cursor. */
export const AtPoint = () => {
    const [point, setPoint] = useState<{ x: number; y: number } | null>(null);

    return (
        <div
            onContextMenu={(event) => {
                event.preventDefault();
                setPoint({ x: event.clientX, y: event.clientY });
            }}
            className="flex h-40 w-72 items-center justify-center rounded-xl bg-app-surface text-xs text-gray-500"
        >
            Right-click here
            {point && (
                <DropdownAtPoint
                    point={point}
                    onClose={() => setPoint(null)}
                    className="w-44"
                >
                    <DropdownItem>Open</DropdownItem>
                    <DropdownItem>Rename</DropdownItem>
                    <DropdownItem variant="destructive">Delete</DropdownItem>
                </DropdownAtPoint>
            )}
        </div>
    );
};

/**
 * The menu's look for a popover that is not a menu, such as a combobox's
 * option list. The caller positions it.
 */
export const SurfaceForNonMenus = () => (
    <DropdownSurface className="relative w-56 p-1">
        <DropdownButton className="flex w-full items-center rounded-lg px-3 py-1.5 text-left">
            First option
        </DropdownButton>
        <DropdownButton className="flex w-full items-center rounded-lg px-3 py-1.5 text-left">
            Second option
        </DropdownButton>
    </DropdownSurface>
);
