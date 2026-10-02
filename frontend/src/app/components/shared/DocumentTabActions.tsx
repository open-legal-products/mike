"use client";

import {
    useEffect,
    useRef,
    useState,
    type KeyboardEvent,
    type MouseEvent,
    type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
    Download,
    FileText,
    MessageSquarePlus,
    Pencil,
    Trash2,
} from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
    LiquidDropdownContent,
    LiquidDropdownItem,
} from "@/app/components/ui/liquid-dropdown";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { userFacingApiError } from "@/app/lib/userFacingError";
import type { HeaderActionsMenuItem } from "./HeaderActionsMenu";

export interface DocumentActions {
    onAddToChat?: () => void | Promise<void>;
    onDownload?: () => void | Promise<void>;
    onRename?: (filename: string) => Promise<void>;
    onDelete?: () => void | Promise<void>;
    addToChatDisabled?: boolean;
    downloading?: boolean;
}

/** Shared file actions; only explorer rows supply an Open action. */
export function documentContextMenuItems(
    actions: Omit<DocumentActions, "onRename"> & {
        onOpen?: () => void;
        onRename?: () => void;
    },
): HeaderActionsMenuItem[] {
    return [
        ...(actions.onOpen
            ? [{ label: "Open", icon: FileText, onSelect: actions.onOpen }]
            : []),
        ...(actions.onAddToChat
            ? [
                  {
                      label: "Add to chat",
                      icon: MessageSquarePlus,
                      onSelect: actions.onAddToChat,
                      disabled: actions.addToChatDisabled,
                  },
              ]
            : []),
        ...(actions.onDownload
            ? [
                  {
                      label: "Download",
                      icon: Download,
                      onSelect: actions.onDownload,
                      disabled: actions.downloading,
                  },
              ]
            : []),
        ...(actions.onRename
            ? [{ label: "Rename", icon: Pencil, onSelect: actions.onRename }]
            : []),
        ...(actions.onDelete
            ? [
                  {
                      label: "Delete file",
                      icon: Trash2,
                      onSelect: actions.onDelete,
                      variant: "danger" as const,
                  },
              ]
            : []),
    ];
}

function RenameInput({
    filename,
    onRename,
    onDone,
}: {
    filename: string;
    onRename: (filename: string) => Promise<void>;
    onDone: () => void;
}) {
    const [value, setValue] = useState(filename);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const finished = useRef(false);
    const input = useRef<HTMLInputElement | null>(null);
    const showingError = useRef(false);
    useEffect(() => {
        input.current?.focus();
        const dot = filename.lastIndexOf(".");
        input.current?.setSelectionRange(0, dot > 0 ? dot : filename.length);
    }, [filename]);
    async function commit() {
        if (finished.current) return;
        const name = value.trim();
        if (!name || name === filename) {
            finished.current = true;
            onDone();
            return;
        }
        finished.current = true;
        setSaving(true);
        try {
            await onRename(name);
            onDone();
        } catch (cause) {
            finished.current = false;
            showingError.current = true;
            setSaving(false);
            setError(
                userFacingApiError(
                    cause,
                    "This file could not be renamed. Please try again.",
                ),
            );
        }
    }
    return (
        <>
            <input
                ref={input}
                aria-label="File name"
                aria-invalid={!!error}
                className="min-w-0 flex-1 rounded-none border-0 border-b border-foreground/20 bg-transparent px-0 text-xs text-foreground outline-none focus-visible:border-foreground/40"
                value={value}
                readOnly={saving}
                onChange={(event) => setValue(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onBlur={() => {
                    if (!showingError.current) void commit();
                }}
                onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                    if (event.key === "Enter") {
                        event.preventDefault();
                        void commit();
                    }
                    if (event.key === "Escape" && !saving) {
                        event.preventDefault();
                        finished.current = true;
                        onDone();
                    }
                }}
            />
            <WarningPopup
                open={!!error}
                title="Rename failed"
                message={error}
                onClose={() => {
                    showingError.current = false;
                    setError(null);
                    input.current?.focus();
                }}
            />
        </>
    );
}

export function DocumentTabActions({
    filename,
    actions,
    children,
}: {
    filename: string;
    actions: DocumentActions;
    children: (props: {
        onContextMenu: (event: MouseEvent<HTMLElement>) => void;
        onMenuKeyDown: (event: KeyboardEvent<HTMLElement>) => boolean;
        renaming: boolean;
        renameInput: ReactNode;
    }) => ReactNode;
}) {
    const [position, setPosition] = useState<{ x: number; y: number } | null>(
        null,
    );
    const [renaming, setRenaming] = useState(false);
    const [tabElement, setTabElement] = useState<HTMLElement | null>(null);
    const [error, setError] = useState<string | null>(null);
    function open(target: HTMLElement, x: number, y: number) {
        if (renaming || !items.length) return;
        setTabElement(target);
        setPosition({ x, y });
    }
    const items = documentContextMenuItems({
        ...actions,
        onRename: actions.onRename
            ? () => {
                  setRenaming(true);
              }
            : undefined,
    });
    return (
        <DropdownMenu
            open={!!position}
            onOpenChange={(open) => {
                if (!open) setPosition(null);
            }}
            modal={false}
        >
            {children({
                onContextMenu: (event) => {
                    if (renaming || !items.length) return;
                    event.preventDefault();
                    event.stopPropagation();
                    open(event.currentTarget, event.clientX, event.clientY);
                },
                onMenuKeyDown: (event) => {
                    if (!items.length || event.target !== event.currentTarget) return false;
                    if (
                        event.key !== "ContextMenu" &&
                        !(event.shiftKey && event.key === "F10")
                    )
                        return false;
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    open(event.currentTarget, rect.left, rect.bottom);
                    return true;
                },
                renaming,
                renameInput:
                    renaming && actions.onRename ? (
                        <RenameInput
                            filename={filename}
                            onRename={actions.onRename}
                            onDone={() => {
                                setRenaming(false);
                                tabElement?.focus();
                            }}
                        />
                    ) : null,
            })}
            {position &&
                createPortal(
                    <DropdownMenuTrigger asChild>
                        <span
                            aria-hidden="true"
                            tabIndex={-1}
                            className="pointer-events-none fixed h-0 w-0"
                            style={{ left: position.x, top: position.y }}
                        />
                    </DropdownMenuTrigger>,
                    document.body,
                )}
            <LiquidDropdownContent
                align="start"
                sideOffset={0}
                className="z-[160] w-44"
                onCloseAutoFocus={(event) => {
                    event.preventDefault();
                    if (!renaming) tabElement?.focus();
                }}
            >
                {items.map(
                    ({ label, icon: Icon, onSelect, disabled, variant }) => (
                        <LiquidDropdownItem
                            key={label}
                            disabled={disabled}
                            variant={
                                variant === "danger" ? "destructive" : "default"
                            }
                            className="text-xs"
                            onSelect={() => {
                                // Also catch synchronous callbacks and leave server details out of the UI.
                                const report = (cause: unknown) =>
                                    setError(
                                        userFacingApiError(
                                            cause,
                                            "This file action could not be completed. Please try again.",
                                        ),
                                    );
                                try {
                                    void Promise.resolve(onSelect()).catch(
                                        report,
                                    );
                                } catch (cause) {
                                    report(cause);
                                }
                            }}
                        >
                            {Icon && <Icon className="h-3.5 w-3.5" />}
                            {label}
                        </LiquidDropdownItem>
                    ),
                )}
            </LiquidDropdownContent>
            <WarningPopup
                open={!!error}
                title="File action failed"
                message={error}
                onClose={() => setError(null)}
            />
        </DropdownMenu>
    );
}
