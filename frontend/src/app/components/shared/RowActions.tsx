"use client";

import { useEffect, useRef, useState } from "react";
import {
    Download,
    Eye,
    EyeOff,
    Eraser,
    FolderMinus,
    Hash,
    History,
    Pencil,
    Plus,
    Trash2,
    Upload,
    X,
} from "lucide-react";
import { SubfolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import {
    CLOSE_ROW_ACTIONS_EVENT,
    closeRowActionMenus,
} from "@/app/components/shared/TablePrimitive";
import {
    Dropdown,
    DropdownContent,
    DropdownItem,
    DropdownTrigger,
} from "@/shared/ui/dropdown";
import { LIQUID_GLASS_HOVER_CLASS } from "@/app/components/ui/liquid-surface";

export { CLOSE_ROW_ACTIONS_EVENT, closeRowActionMenus };

interface Props {
    onDeselect?: () => void;
    onView?: () => void;
    /** Copies the row into the caller's own collection; `addLabel` names it. */
    onAdd?: () => void;
    addLabel?: string;
    onDelete?: () => void | Promise<void>;
    onHide?: () => void;
    onUnhide?: () => void;
    onDownload?: () => void;
    onClearResults?: () => void;
    clearResultsDisabled?: boolean;
    onRemoveFromFolder?: () => void;
    onShowAllVersions?: () => void;
    onUploadNewVersion?: () => void;
    onNewSubfolder?: () => void;
    /**
     * Offered but refused: the caller's role cannot organize folders here.
     * Shown disabled rather than hidden, so the menu is the same shape for
     * everybody and the reason is legible — the same treatment Delete has.
     */
    newSubfolderDisabled?: boolean;
    deleting?: boolean;
    deleteDisabled?: boolean;
    onEditDetails?: () => void;
    onRename?: () => void;
    onUpdateCmNumber?: () => void;
    viewLabel?: string;
    editDetailsLabel?: string;
    newSubfolderLabel?: string;
    renameLabel?: string;
    uploadNewVersionLabel?: string;
    deleteLabel?: string;
}
type RowActionMenuItemsProps = Props & {
    /** Called when an action is chosen. The menu closes on its own. */
    onClose?: () => void;
};

/**
 * The actions of a row menu, as dropdown items. Render them inside a
 * `DropdownContent`: `RowActions` does for the row's button, and
 * `DropdownAtPoint` does for a right-click menu.
 */
export function RowActionMenuItems({
    onDeselect,
    onView,
    onAdd,
    addLabel = "Add",
    onDelete,
    onHide,
    onUnhide,
    onDownload,
    onClearResults,
    clearResultsDisabled,
    onRemoveFromFolder,
    onShowAllVersions,
    onUploadNewVersion,
    onNewSubfolder,
    newSubfolderDisabled = false,
    deleting,
    deleteDisabled = false,
    onEditDetails,
    onRename,
    onUpdateCmNumber,
    viewLabel = "View",
    editDetailsLabel = "Edit details",
    newSubfolderLabel = "New subfolder",
    renameLabel = "Rename",
    uploadNewVersionLabel = "Upload new version",
    deleteLabel = "Delete",
    onClose,
}: RowActionMenuItemsProps) {
    const run = (action: () => void) => () => {
        onClose?.();
        action();
    };

    return (
        <>
            {onDeselect && (
                <DropdownItem onSelect={run(onDeselect)}>
                    <X className="h-3.5 w-3.5" />
                    Deselect rows
                </DropdownItem>
            )}
            {onView && (
                <DropdownItem onSelect={run(onView)}>
                    <Eye className="h-3.5 w-3.5" />
                    {viewLabel}
                </DropdownItem>
            )}
            {onAdd && (
                <DropdownItem onSelect={run(onAdd)}>
                    <Plus className="h-3.5 w-3.5" />
                    {addLabel}
                </DropdownItem>
            )}
            {onNewSubfolder && (
                // Offered but refused when disabled, so the menu is the same
                // shape for everybody.
                <DropdownItem
                    disabled={newSubfolderDisabled}
                    onSelect={run(onNewSubfolder)}
                >
                    <SubfolderSvgIcon className="h-3.5 w-3.5 shrink-0" />
                    {newSubfolderLabel}
                </DropdownItem>
            )}
            {onRename && (
                <DropdownItem onSelect={run(onRename)}>
                    <Pencil className="h-3.5 w-3.5" />
                    {renameLabel}
                </DropdownItem>
            )}
            {onEditDetails && (
                <DropdownItem onSelect={run(onEditDetails)}>
                    <Pencil className="h-3.5 w-3.5" />
                    {editDetailsLabel}
                </DropdownItem>
            )}
            {onUpdateCmNumber && (
                <DropdownItem onSelect={run(onUpdateCmNumber)}>
                    <Hash className="h-3.5 w-3.5" />
                    Edit CM No.
                </DropdownItem>
            )}
            {onDownload && (
                <DropdownItem onSelect={run(onDownload)}>
                    <Download className="h-3.5 w-3.5" />
                    Download
                </DropdownItem>
            )}
            {onShowAllVersions && (
                <DropdownItem onSelect={run(onShowAllVersions)}>
                    <History className="h-3.5 w-3.5" />
                    Show all versions
                </DropdownItem>
            )}
            {onUploadNewVersion && (
                <DropdownItem onSelect={run(onUploadNewVersion)}>
                    <Upload className="h-3.5 w-3.5" />
                    {uploadNewVersionLabel}
                </DropdownItem>
            )}
            {onRemoveFromFolder && (
                <DropdownItem onSelect={run(onRemoveFromFolder)}>
                    <FolderMinus className="h-3.5 w-3.5" />
                    Remove from subfolder
                </DropdownItem>
            )}
            {onClearResults && (
                <DropdownItem disabled={clearResultsDisabled} onSelect={run(onClearResults)}>
                    <Eraser className="h-3.5 w-3.5" />
                    Clear results
                </DropdownItem>
            )}
            {onUnhide && (
                <DropdownItem onSelect={run(onUnhide)}>
                    <Eye className="h-3.5 w-3.5" />
                    Activate
                </DropdownItem>
            )}
            {onHide && (
                <DropdownItem onSelect={run(onHide)}>
                    <EyeOff className="h-3.5 w-3.5" />
                    Deactivate
                </DropdownItem>
            )}
            {onDelete && (
                <DropdownItem
                    variant="destructive"
                    disabled={deleting || deleteDisabled}
                    onSelect={run(() => {
                        // The menu closes immediately, so an async handler that
                        // rejects has nothing left to report to. Swallow it here
                        // rather than leaving an unhandled rejection; surfaces
                        // that can explain the failure do so themselves.
                        void Promise.resolve(onDelete()).catch((error) => {
                            console.error("row delete action failed", error);
                        });
                    })}
                >
                    <Trash2 className="h-3.5 w-3.5" />
                    {deleteLabel}
                </DropdownItem>
            )}
        </>
    );
}

/** Width shared by the row button menu and the right-click menu. */
export const ROW_ACTION_MENU_CLASS = "w-48";

export function RowActions(props: Props) {
    const [open, setOpen] = useState(false);
    // An action often opens something that takes focus itself (an inline
    // rename field, a modal). Returning focus to the button afterwards would
    // blur it, so focus only returns when the menu is dismissed unused.
    const actionChosenRef = useRef(false);

    // Lets a table close an open row menu when its rows change underneath it.
    useEffect(() => {
        if (!open) return;
        function handleCloseRowActions() {
            setOpen(false);
        }
        document.addEventListener(CLOSE_ROW_ACTIONS_EVENT, handleCloseRowActions);
        return () =>
            document.removeEventListener(
                CLOSE_ROW_ACTIONS_EVENT,
                handleCloseRowActions,
            );
    }, [open]);

    return (
        <Dropdown open={open} onOpenChange={setOpen}>
            <DropdownTrigger asChild>
                <button
                    type="button"
                    aria-label="Open row actions"
                    // The row itself is clickable; opening its menu must not
                    // also activate the row.
                    onClick={(event) => event.stopPropagation()}
                    className={`flex h-6 w-6 items-center justify-center rounded leading-none text-gray-700 transition-colors hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ${LIQUID_GLASS_HOVER_CLASS}`}
                >
                    <span aria-hidden className="text-xs tracking-widest">···</span>
                </button>
            </DropdownTrigger>
            <DropdownContent
                align="end"
                className={ROW_ACTION_MENU_CLASS}
                // React events bubble through the portal to the row.
                onClick={(event) => event.stopPropagation()}
                onCloseAutoFocus={(event) => {
                    if (actionChosenRef.current) event.preventDefault();
                    actionChosenRef.current = false;
                }}
            >
                <RowActionMenuItems
                    {...props}
                    onClose={() => {
                        actionChosenRef.current = true;
                    }}
                />
            </DropdownContent>
        </Dropdown>
    );
}
