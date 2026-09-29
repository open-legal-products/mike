"use client";

import {
    useEffect,
    useRef,
    useState,
    type DragEvent,
    type ReactNode,
} from "react";
import {
    DocumentTabActions,
    type DocumentActions,
} from "@/app/components/shared/DocumentTabActions";
import { X } from "lucide-react";
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import { VersionChip } from "@/app/components/shared/VersionChip";
import type { TabDropPosition } from "@/app/lib/reorderTabs";
import { cn } from "@/app/lib/utils";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

export interface DocumentTabItem {
    id: string;
    title: string;
    icon?: ReactNode;
    versionNumber?: number | null;
    actions?: DocumentActions;
}

interface Props {
    tabs: ReadonlyArray<DocumentTabItem>;
    activeTabId: string | null;
    label: string;
    idPrefix: string;
    emptyLabel?: string;
    className?: string;
    onActivate: (id: string) => void;
    onClose: (id: string) => void;
    onClosePanel?: () => void;
    onReorder?: (
        draggedId: string,
        targetId: string,
        position: TabDropPosition,
    ) => void;
}

/** Shared document tabs: navigation, reordering, inline rename and file actions. */
export function DocumentTabBar({
    tabs,
    activeTabId,
    label,
    idPrefix,
    emptyLabel = "Document Viewer",
    className,
    onActivate,
    onClose,
    onClosePanel,
    onReorder,
}: Props) {
    const dragType = `application/mike-${idPrefix}-tab`;
    const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const draggedIdRef = useRef<string | null>(null);
    const [draggedId, setDraggedId] = useState<string | null>(null);
    const [dropTarget, setDropTarget] = useState<{
        id: string;
        position: TabDropPosition;
    } | null>(null);

    useEffect(() => {
        if (!activeTabId) return;
        itemRefs.current[activeTabId]?.scrollIntoView?.({
            behavior: "smooth",
            block: "nearest",
            inline: "nearest",
        });
    }, [activeTabId, tabs.length]);

    function clearDrag() {
        draggedIdRef.current = null;
        setDraggedId(null);
        setDropTarget(null);
    }

    function dropPosition(event: DragEvent<HTMLDivElement>): TabDropPosition {
        const rect = event.currentTarget.getBoundingClientRect();
        return event.clientX < rect.left + rect.width / 2 ? "before" : "after";
    }

    function dragOver(
        event: DragEvent<HTMLDivElement>,
        targetId: string,
        position?: TabDropPosition,
    ) {
        if (!onReorder || !draggedIdRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        if (draggedIdRef.current === targetId) {
            setDropTarget(null);
            return;
        }
        setDropTarget({
            id: targetId,
            position: position ?? dropPosition(event),
        });
    }

    function drop(
        event: DragEvent<HTMLDivElement>,
        targetId: string,
        position?: TabDropPosition,
    ) {
        const sourceId =
            draggedIdRef.current ?? event.dataTransfer.getData(dragType);
        if (!onReorder || !sourceId || !tabs.some((tab) => tab.id === sourceId))
            return;
        event.preventDefault();
        event.stopPropagation();
        if (sourceId !== targetId)
            onReorder(sourceId, targetId, position ?? dropPosition(event));
        clearDrag();
    }

    return (
        <div className="flex min-w-0 shrink-0 items-center">
            <div
                role="tablist"
                aria-label={label}
                className={cn(
                    "document-tab-bar flex h-10 flex-1 min-w-0 shrink-0 items-center gap-1 overflow-x-auto px-1 py-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden",
                    tabs.length ? "bg-transparent" : "bg-app-surface",
                    className,
                )}
            >
                {tabs.length === 0 ? (
                    <span className="self-center px-2 text-xs text-muted-foreground">
                        {emptyLabel}
                    </span>
                ) : (
                    tabs.map((tab, index) => {
                        const isActive = tab.id === activeTabId;
                        const versionNumber = tab.versionNumber;
                        const showVersion =
                            typeof versionNumber === "number" &&
                            Number.isFinite(versionNumber) &&
                            versionNumber > 1;
                        return (
                            <DocumentTabActions
                                key={tab.id}
                                filename={tab.title}
                                actions={tab.actions ?? {}}
                            >
                                {({
                                    onContextMenu,
                                    onMenuKeyDown,
                                    renaming,
                                    renameInput,
                                }) => (
                                    <div
                                        onContextMenu={onContextMenu}
                                        ref={(element) => {
                                            itemRefs.current[tab.id] = element;
                                        }}
                                        role="tab"
                                        id={`${idPrefix}-tab-${tab.id}`}
                                        aria-controls={
                                            isActive
                                                ? `${idPrefix}-panel-${tab.id}`
                                                : undefined
                                        }
                                        tabIndex={
                                            isActive ||
                                            (!activeTabId && index === 0)
                                                ? 0
                                                : -1
                                        }
                                        aria-selected={isActive}
                                        aria-label={tab.title}
                                        draggable={
                                            !renaming &&
                                            !!onReorder &&
                                            tabs.length > 1
                                        }
                                        onDragStart={(event) => {
                                            if (!onReorder) return;
                                            draggedIdRef.current = tab.id;
                                            setDraggedId(tab.id);
                                            event.dataTransfer.effectAllowed =
                                                "move";
                                            event.dataTransfer.setData(
                                                dragType,
                                                tab.id,
                                            );
                                        }}
                                        onDragOver={(event) =>
                                            dragOver(event, tab.id)
                                        }
                                        onDrop={(event) => drop(event, tab.id)}
                                        onDragEnd={clearDrag}
                                        onClick={() => onActivate(tab.id)}
                                        onKeyDown={(event) => {
                                            if (onMenuKeyDown(event)) return;
                                            if (
                                                event.target !==
                                                event.currentTarget
                                            )
                                                return;
                                            if (
                                                event.key === "Enter" ||
                                                event.key === " "
                                            ) {
                                                event.preventDefault();
                                                onActivate(tab.id);
                                            }
                                            if (
                                                !event.altKey &&
                                                [
                                                    "ArrowLeft",
                                                    "ArrowRight",
                                                    "Home",
                                                    "End",
                                                ].includes(event.key)
                                            ) {
                                                event.preventDefault();
                                                const nextIndex =
                                                    event.key === "Home"
                                                        ? 0
                                                        : event.key === "End"
                                                          ? tabs.length - 1
                                                          : (index +
                                                                (event.key ===
                                                                "ArrowLeft"
                                                                    ? -1
                                                                    : 1) +
                                                                tabs.length) %
                                                            tabs.length;
                                                const target = tabs[nextIndex];
                                                onActivate(target.id);
                                                itemRefs.current[
                                                    target.id
                                                ]?.focus();
                                            }
                                            if (
                                                onReorder &&
                                                event.altKey &&
                                                (event.key === "ArrowLeft" ||
                                                    event.key === "ArrowRight")
                                            ) {
                                                const direction =
                                                    event.key === "ArrowLeft"
                                                        ? -1
                                                        : 1;
                                                const target =
                                                    tabs[index + direction];
                                                if (!target) return;
                                                event.preventDefault();
                                                onReorder(
                                                    tab.id,
                                                    target.id,
                                                    direction === -1
                                                        ? "before"
                                                        : "after",
                                                );
                                            }
                                        }}
                                        data-active={
                                            isActive ? "true" : "false"
                                        }
                                        className={cn(
                                            "document-tab group relative flex h-7 min-w-0 max-w-[220px] shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md pl-3 pr-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40",
                                            isActive ? "z-20" : "z-10",
                                            onReorder &&
                                                tabs.length > 1 &&
                                                "cursor-grab active:cursor-grabbing",
                                            draggedId === tab.id &&
                                                "opacity-55",
                                        )}
                                    >
                                        {dropTarget?.id === tab.id &&
                                            draggedId !== tab.id && (
                                                <span
                                                    aria-hidden="true"
                                                    className={cn(
                                                        "pointer-events-none absolute inset-y-1 z-30 w-0.5 rounded-full bg-blue-500",
                                                        dropTarget.position ===
                                                            "before"
                                                            ? "left-0"
                                                            : "right-0",
                                                    )}
                                                />
                                            )}
                                        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                                            {tab.icon ?? (
                                                <FileTypeIcon
                                                    fileType={tab.title}
                                                    className="h-3.5 w-3.5"
                                                />
                                            )}
                                            {renameInput || (
                                                <span
                                                    className="min-w-0 flex-1 truncate text-xs font-normal"
                                                    title={tab.title}
                                                >
                                                    {tab.title}
                                                </span>
                                            )}
                                            {showVersion && (
                                                <VersionChip
                                                    n={versionNumber}
                                                    size="sm"
                                                />
                                            )}
                                        </div>
                                        <button
                                            type="button"
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                onClose(tab.id);
                                            }}
                                            className="shrink-0 rounded-full p-0.5 text-gray-400 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                            aria-label={`Close ${tab.title}`}
                                        >
                                            <X
                                                aria-hidden="true"
                                                className="h-3 w-3"
                                            />
                                        </button>
                                    </div>
                                )}
                            </DocumentTabActions>
                        );
                    })
                )}
                {tabs.length > 0 && (
                    <div
                        aria-hidden="true"
                        className="h-7 min-w-4 flex-1"
                        onDragOver={(event) =>
                            dragOver(event, tabs[tabs.length - 1].id, "after")
                        }
                        onDrop={(event) =>
                            drop(event, tabs[tabs.length - 1].id, "after")
                        }
                    />
                )}
            </div>
            {onClosePanel && (
                <PillButtonUI
                    tone="white"
                    size="icon-xs"
                    onClick={onClosePanel}
                    aria-label="Close panel"
                    title="Close panel"
                    className="mt-2 ml-2 mr-2 h-4 w-4 shrink-0 self-start"
                >
                    <X aria-hidden="true" className="h-2.5 w-2.5" />
                </PillButtonUI>
            )}
        </div>
    );
}
