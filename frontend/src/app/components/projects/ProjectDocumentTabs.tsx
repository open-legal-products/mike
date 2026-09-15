"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { X } from "lucide-react";
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import { VersionChip } from "@/app/components/shared/VersionChip";
import type { Document } from "@/app/components/shared/types";
import type { TabDropPosition } from "@/app/lib/reorderTabs";
import { cn } from "@/app/lib/utils";

const TAB_DRAG_TYPE = "application/mike-project-document-tab";

interface Props {
    tabs: ReadonlyArray<{ documentId: string; filename: string }>;
    documents: ReadonlyArray<Document>;
    activeTabId: string | null;
    onActivate: (documentId: string) => void;
    onClose: (documentId: string) => void;
    onReorder: (
        draggedId: string,
        targetId: string,
        position: TabDropPosition,
    ) => void;
}

export function ProjectDocumentTabs({
    tabs,
    documents,
    activeTabId,
    onActivate,
    onClose,
    onReorder,
}: Props) {
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
        if (!draggedIdRef.current) return;
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
            draggedIdRef.current ?? event.dataTransfer.getData(TAB_DRAG_TYPE);
        if (!sourceId) return;
        event.preventDefault();
        event.stopPropagation();
        if (sourceId !== targetId)
            onReorder(sourceId, targetId, position ?? dropPosition(event));
        clearDrag();
    }

    return (
        <div
            role="tablist"
            aria-label="Project documents"
            className="project-document-tabs flex h-10 min-w-0 shrink-0 items-end gap-1 overflow-x-auto bg-app-surface px-1 pt-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        >
            {tabs.length === 0 ? (
                <span className="self-center px-2 text-xs text-muted-foreground">
                    Document Viewer
                </span>
            ) : (
                tabs.map((tab, index) => {
                    const isActive = tab.documentId === activeTabId;
                    const versionNumber = documents.find(
                        (document) => document.id === tab.documentId,
                    )?.latest_version_number;
                    const showVersion =
                        typeof versionNumber === "number" &&
                        Number.isFinite(versionNumber) &&
                        versionNumber > 1;
                    return (
                        <div
                            key={tab.documentId}
                            ref={(element) => {
                                itemRefs.current[tab.documentId] = element;
                            }}
                            role="tab"
                            id={`project-document-tab-${tab.documentId}`}
                            aria-controls={
                                isActive
                                    ? `project-document-panel-${tab.documentId}`
                                    : undefined
                            }
                            tabIndex={
                                isActive || (!activeTabId && index === 0)
                                    ? 0
                                    : -1
                            }
                            aria-selected={isActive}
                            aria-label={tab.filename}
                            draggable={tabs.length > 1}
                            onDragStart={(event) => {
                                draggedIdRef.current = tab.documentId;
                                setDraggedId(tab.documentId);
                                event.dataTransfer.effectAllowed = "move";
                                event.dataTransfer.setData(
                                    TAB_DRAG_TYPE,
                                    tab.documentId,
                                );
                            }}
                            onDragOver={(event) =>
                                dragOver(event, tab.documentId)
                            }
                            onDrop={(event) => drop(event, tab.documentId)}
                            onDragEnd={clearDrag}
                            onClick={() => onActivate(tab.documentId)}
                            onKeyDown={(event) => {
                                if (event.target !== event.currentTarget)
                                    return;
                                if (
                                    event.key === "Enter" ||
                                    event.key === " "
                                ) {
                                    event.preventDefault();
                                    onActivate(tab.documentId);
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
                                                    (event.key === "ArrowLeft"
                                                        ? -1
                                                        : 1) +
                                                    tabs.length) %
                                                tabs.length;
                                    const target = tabs[nextIndex];
                                    onActivate(target.documentId);
                                    itemRefs.current[
                                        target.documentId
                                    ]?.focus();
                                }
                                if (
                                    event.altKey &&
                                    (event.key === "ArrowLeft" ||
                                        event.key === "ArrowRight")
                                ) {
                                    const direction =
                                        event.key === "ArrowLeft" ? -1 : 1;
                                    const target = tabs[index + direction];
                                    if (!target) return;
                                    event.preventDefault();
                                    onReorder(
                                        tab.documentId,
                                        target.documentId,
                                        direction === -1 ? "before" : "after",
                                    );
                                }
                            }}
                            data-active={isActive ? "true" : "false"}
                            className={cn(
                                "document-tab group relative flex h-9 min-w-0 max-w-[220px] shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-t-lg pl-3 pr-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40",
                                isActive ? "z-20" : "z-10",
                                tabs.length > 1 &&
                                    "cursor-grab active:cursor-grabbing",
                                draggedId === tab.documentId && "opacity-55",
                            )}
                        >
                            {dropTarget?.id === tab.documentId &&
                                draggedId !== tab.documentId && (
                                    <span
                                        aria-hidden="true"
                                        className={cn(
                                            "pointer-events-none absolute inset-y-1 z-30 w-0.5 rounded-full bg-blue-500",
                                            dropTarget.position === "before"
                                                ? "left-0"
                                                : "right-0",
                                        )}
                                    />
                                )}
                            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                                <FileTypeIcon
                                    fileType={tab.filename}
                                    className="h-3.5 w-3.5"
                                />
                                <span
                                    className={cn(
                                        "min-w-0 flex-1 truncate text-xs",
                                        isActive
                                            ? "font-medium"
                                            : "font-normal",
                                    )}
                                    title={tab.filename}
                                >
                                    {tab.filename}
                                </span>
                                {showVersion && (
                                    <VersionChip n={versionNumber} size="sm" />
                                )}
                            </div>
                            <button
                                type="button"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onClose(tab.documentId);
                                }}
                                className="shrink-0 rounded-full p-0.5 text-gray-400 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                aria-label={`Close ${tab.filename}`}
                            >
                                <X aria-hidden="true" className="h-3 w-3" />
                            </button>
                        </div>
                    );
                })
            )}
            {tabs.length > 0 && (
                <div
                    aria-hidden="true"
                    className="h-9 min-w-4 flex-1"
                    onDragOver={(event) =>
                        dragOver(
                            event,
                            tabs[tabs.length - 1].documentId,
                            "after",
                        )
                    }
                    onDrop={(event) =>
                        drop(event, tabs[tabs.length - 1].documentId, "after")
                    }
                />
            )}
        </div>
    );
}
