"use client";

import { useRef } from "react";
import {
    ClipboardCheck,
    Cloud,
    PlusIcon,
    Upload,
    Waypoints,
} from "lucide-react";
import {
    Dropdown,
    DropdownContent,
    DropdownItem,
    DropdownSeparator,
    DropdownTrigger,
} from "@/shared/ui/dropdown";

interface Props {
    onBrowseAll: () => void;
    onLocalFiles: () => void;
    /** Adds the workflow and playbook pickers to the menu. */
    onWorkflows?: () => void;
    onPlaybooks?: () => void;
}

/** The composer's + menu: documents, then workflows and playbooks. */
export function AddDocButton({
    onBrowseAll,
    onLocalFiles,
    onWorkflows,
    onPlaybooks,
}: Props) {
    const openingDialog = useRef(false);
    return (
        <Dropdown>
            <DropdownTrigger asChild>
                <button
                    type="button"
                    className="flex h-7.5 items-center gap-1 rounded-lg px-2 text-sm text-gray-400 transition-colors hover:text-gray-700 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                    title="Add to message"
                    aria-label="Add to message"
                >
                    <PlusIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
                </button>
            </DropdownTrigger>
            <DropdownContent
                side="top"
                align="start"
                sideOffset={8}
                collisionPadding={12}
                className="min-w-36"
                onCloseAutoFocus={(event) => {
                    // Let the newly opened picker own focus instead of returning
                    // it to the composer trigger as the menu unmounts.
                    if (openingDialog.current) event.preventDefault();
                    openingDialog.current = false;
                }}
            >
                <DropdownItem onSelect={onLocalFiles}>
                    <Upload aria-hidden="true" className="h-4 w-4 shrink-0 text-gray-500" />
                    Upload Documents
                </DropdownItem>
                <DropdownItem onSelect={() => {
                    openingDialog.current = true;
                    onBrowseAll();
                }}>
                    <Cloud aria-hidden="true" className="h-4 w-4 shrink-0 text-gray-500" />
                    Saved Documents
                </DropdownItem>
                {(onWorkflows || onPlaybooks) && <DropdownSeparator />}
                {onWorkflows && (
                    <DropdownItem onSelect={() => {
                        openingDialog.current = true;
                        onWorkflows();
                    }}>
                        <Waypoints aria-hidden="true" className="h-4 w-4 shrink-0 text-gray-500" />
                        Workflows
                    </DropdownItem>
                )}
                {onPlaybooks && (
                    <DropdownItem onSelect={() => {
                        openingDialog.current = true;
                        onPlaybooks();
                    }}>
                        <ClipboardCheck aria-hidden="true" className="h-4 w-4 shrink-0 text-gray-500" />
                        Playbooks
                    </DropdownItem>
                )}
            </DropdownContent>
        </Dropdown>
    );
}
