"use client";

import { useRef, type ReactNode } from "react";
import { cn } from "@/app/lib/utils";
import { ROW_ACTION_MENU_CLASS } from "./RowActions";
import { ChevronDown } from "lucide-react";
import {
    Dropdown,
    DropdownContent,
    DropdownTrigger,
} from "@/shared/ui/dropdown";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";

function SelectionMenuContent({
    renderItems,
    onActionChosen,
}: {
    renderItems: (onActionChosen: () => void) => ReactNode;
    onActionChosen: () => void;
}) {
    return renderItems(onActionChosen);
}

/**
 * The toolbar "Actions" menu a table shows while rows are selected. Reuse
 * the row context menu's renderer for `renderItems` so both menus stay in sync.
 * Pass `open` and `onOpenChange` only when the page needs to close it itself.
 */
export function SelectionActionsMenu({
    renderItems,
    open,
    onOpenChange,
    className,
}: {
    renderItems: (onActionChosen: () => void) => ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** Applied to the trigger, for responsive visibility. */
    className?: string;
}) {
    const actionChosenRef = useRef(false);
    return (
        <Dropdown
            open={open}
            onOpenChange={onOpenChange}
            modal={false}
        >
            <DropdownTrigger asChild>
                <TabPillButtonUI
                    data-icon-position="right"
                    className={cn("pl-3 pr-2", className)}
                >
                    Actions
                    <ChevronDown className="h-3.5 w-3.5" />
                </TabPillButtonUI>
            </DropdownTrigger>
            <DropdownContent
                align="end"
                className={ROW_ACTION_MENU_CLASS}
                onCloseAutoFocus={(event) => {
                    if (actionChosenRef.current) event.preventDefault();
                    actionChosenRef.current = false;
                }}
            >
                <SelectionMenuContent
                    renderItems={renderItems}
                    onActionChosen={() => {
                        actionChosenRef.current = true;
                    }}
                />
            </DropdownContent>
        </Dropdown>
    );
}
