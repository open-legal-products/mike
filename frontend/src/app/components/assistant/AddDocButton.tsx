"use client";

import { useRef } from "react";
import { Library, Loader2, PlusIcon, Upload } from "lucide-react";
import {
    Dropdown,
    DropdownContent,
    DropdownItem,
    DropdownTrigger,
} from "@/shared/ui/dropdown";

interface Props {
    onBrowseAll: () => void;
    onLocalFiles: () => void;
    selectedDocIds?: string[];
    hideLabel?: boolean;
    uploading?: boolean;
}

export function AddDocButton({
    onBrowseAll,
    onLocalFiles,
    selectedDocIds = [],
    hideLabel = false,
    uploading = false,
}: Props) {
    const openingDialog = useRef(false);
    return (
        <Dropdown>
            <DropdownTrigger asChild>
                <button
                    type="button"
                    disabled={uploading}
                    className={`flex h-7.5 items-center gap-1 rounded-lg px-2 text-sm transition-colors cursor-pointer disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ${
                        selectedDocIds.length > 0
                            ? "text-gray-700 hover:text-gray-900"
                            : "text-gray-400 hover:text-gray-700"
                    }`}
                    title="Add documents"
                    aria-label="Add documents"
                >
                    {uploading ? (
                        <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin" />
                    ) : selectedDocIds.length > 0 ? (
                        <span className="font-medium tabular-nums">{selectedDocIds.length}</span>
                    ) : (
                        <PlusIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
                    )}
                    <span className={hideLabel ? "hidden" : "hidden sm:inline"}>
                        {selectedDocIds.length === 1 ? "Document" : "Documents"}
                    </span>
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
                    <Library aria-hidden="true" className="h-4 w-4 shrink-0 text-gray-500" />
                    Saved Documents
                </DropdownItem>
            </DropdownContent>
        </Dropdown>
    );
}
