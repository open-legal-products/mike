"use client";

import { Files, FolderUp, Upload } from "lucide-react";
import {
    Dropdown,
    DropdownContent,
    DropdownItem,
    DropdownTrigger,
} from "@/shared/ui/dropdown";
import { HeaderButtonUI } from "@/shared/ui/HeaderButtonsUI";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";

interface DocumentUploadMenuProps {
    onSavedFiles?: (() => void) | null;
    onUploadFiles: (() => void) | null;
    onUploadFolder?: (() => void) | null;
    disabled?: boolean;
    toolbar?: boolean;
}

export function DocumentUploadMenu({
    onSavedFiles,
    onUploadFiles,
    onUploadFolder,
    disabled = false,
    toolbar = false,
}: DocumentUploadMenuProps) {
    const TriggerButton = toolbar ? TabPillButtonUI : HeaderButtonUI;
    const triggerDisabled =
        disabled || (!onSavedFiles && !onUploadFiles && !onUploadFolder);

    return (
        <Dropdown>
            <DropdownTrigger asChild>
                <TriggerButton
                    disabled={triggerDisabled}
                    title="Upload"
                    aria-label="Upload"
                    {...(toolbar ? { className: "pl-2" } : { iconOnly: true })}
                >
                    <Upload aria-hidden="true" className="h-3.5 w-3.5" />
                    {toolbar && "Upload"}
                </TriggerButton>
            </DropdownTrigger>
            <DropdownContent
                align="end"
                className="min-w-40 p-1"
            >
                {onSavedFiles !== undefined && (
                    <DropdownItem
                        disabled={disabled || !onSavedFiles}
                        onSelect={() => onSavedFiles?.()}
                        className="flex items-center px-3 py-2"
                    >
                        <Files className="mr-2 h-3.5 w-3.5" />
                        Saved Documents
                    </DropdownItem>
                )}
                <DropdownItem
                    disabled={disabled || !onUploadFiles}
                    onSelect={() => onUploadFiles?.()}
                    className="flex items-center px-3 py-2"
                >
                    <Upload className="mr-2 h-3.5 w-3.5" />
                    Upload Documents
                </DropdownItem>
                {onUploadFolder !== undefined && (
                    <DropdownItem
                        disabled={disabled || !onUploadFolder}
                        onSelect={() => onUploadFolder?.()}
                        className="flex items-center px-3 py-2"
                    >
                        <FolderUp className="mr-2 h-3.5 w-3.5" />
                        Upload folder
                    </DropdownItem>
                )}
            </DropdownContent>
        </Dropdown>
    );
}
