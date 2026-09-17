import { useState } from "react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";

const meta = { title: "UI / DropdownMenu" };
export default meta;

/**
 * The raw Radix/shadcn menu primitives. In app chrome use `liquid-dropdown`
 * instead — it is the glass skin over these.
 */
export const Default = () => (
    <DropdownMenu>
        <DropdownMenuTrigger asChild>
            <PillButtonUI tone="white">Open menu</PillButtonUI>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
            <DropdownMenuLabel>Document</DropdownMenuLabel>
            <DropdownMenuGroup>
                <DropdownMenuItem>
                    Rename
                    <DropdownMenuShortcut>⌘R</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem>Duplicate</DropdownMenuItem>
                <DropdownMenuItem disabled>Move to matter</DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
        </DropdownMenuContent>
    </DropdownMenu>
);

export const CheckboxAndRadioItems = () => {
    const [showRedlines, setShowRedlines] = useState(true);
    const [showComments, setShowComments] = useState(false);
    const [sort, setSort] = useState("recent");

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <PillButtonUI tone="white">View options</PillButtonUI>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
                <DropdownMenuLabel>Show</DropdownMenuLabel>
                <DropdownMenuCheckboxItem
                    checked={showRedlines}
                    onCheckedChange={setShowRedlines}
                >
                    Redlines
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                    checked={showComments}
                    onCheckedChange={setShowComments}
                >
                    Comments
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
                    <DropdownMenuRadioItem value="recent">
                        Most recent
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="name">
                        Name
                    </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

export const WithSubmenu = () => (
    <DropdownMenu>
        <DropdownMenuTrigger asChild>
            <PillButtonUI tone="white">Export</PillButtonUI>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
            <DropdownMenuItem>Export as DOCX</DropdownMenuItem>
            <DropdownMenuSub>
                <DropdownMenuSubTrigger>Export as PDF</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                    <DropdownMenuItem>With comments</DropdownMenuItem>
                    <DropdownMenuItem>Clean copy</DropdownMenuItem>
                </DropdownMenuSubContent>
            </DropdownMenuSub>
        </DropdownMenuContent>
    </DropdownMenu>
);
