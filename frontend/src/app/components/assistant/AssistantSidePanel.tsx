"use client";

import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type CSSProperties,
} from "react";
import Image from "next/image";
import { X } from "lucide-react";
import { DocPanel, type DocPanelMode } from "./DocPanel";
import { FileTypeIcon } from "../shared/FileTypeIcon";
import { VersionChip } from "../shared/VersionChip";
import type { Citation, EditAnnotation, PanelDocument } from "../shared/types";
import { cn } from "@/app/lib/utils";
import { LIQUID_GLASS_FLOAT_CLASS } from "@/app/components/ui/liquid-surface";
import { reorderTabs, type TabDropPosition } from "@/app/lib/reorderTabs";

// ---------------------------------------------------------------------------
// Tab data
// ---------------------------------------------------------------------------
//
// Each tab represents ONE of:
//   - a document view (no specific annotation),
//   - a single citation quote,
//   - a single tracked change.
// There is no selector UI inside the panel — the user picks what to view
// by clicking a different tab (or opening a new one from a citation pill,
// an EditCard's View button, or the download card).

type CommonTab = {
    id: string;
    document: PanelDocument;
    warning?: string | null;
    initialScrollTop?: number | null;
};

export type DocumentTab = CommonTab & { kind: "document" };

export type CitationTab = CommonTab & {
    kind: "citation";
    citation: Citation;
};

export type EditTab = CommonTab & {
    kind: "edit";
    edit: EditAnnotation;
    changeNumber?: number;
};

export type AssistantSidePanelTab = DocumentTab | CitationTab | EditTab;

/**
 * A document version owns one panel tab. Explicit versions use their stable
 * version id; older links without one fall back to the version number and then
 * to the document's current version.
 */
export function assistantSidePanelTabId(document: PanelDocument): string {
    const version = document.version_id
        ? `id:${document.version_id}`
        : document.version_number != null
          ? `number:${document.version_number}`
          : "current";
    return `${document.document_id}::${version}`;
}

export function mergeAssistantSidePanelTab(
    existing: AssistantSidePanelTab,
    incoming: AssistantSidePanelTab,
): AssistantSidePanelTab {
    if (existing.id !== incoming.id) {
        return incoming;
    }
    if (existing.kind === "document" && incoming.kind === "document") {
        if (
            incoming.document.subdocuments?.length &&
            !existing.document.subdocuments?.length
        ) {
            return {
                ...existing,
                document: incoming.document,
            };
        }
        return existing;
    }
    return {
        ...incoming,
        id: existing.id,
        warning: existing.warning,
        initialScrollTop: existing.initialScrollTop,
    };
}

export function upsertAssistantSidePanelTab(
    tabs: AssistantSidePanelTab[],
    incoming: AssistantSidePanelTab,
): AssistantSidePanelTab[] {
    const index = tabs.findIndex((tab) => tab.id === incoming.id);
    if (index < 0) return [...tabs, incoming];

    const existing = tabs[index];
    const merged = mergeAssistantSidePanelTab(existing, incoming);
    if (merged === existing) return tabs;

    const next = tabs.slice();
    next[index] = merged;
    return next;
}

export type AssistantTabDropPosition = TabDropPosition;

export function reorderAssistantSidePanelTabs(
    tabs: AssistantSidePanelTab[],
    draggedTabId: string,
    targetTabId: string,
    position: AssistantTabDropPosition,
): AssistantSidePanelTab[] {
    return reorderTabs(tabs, draggedTabId, targetTabId, position, (tab) => tab.id);
}

interface Props {
    tabs: AssistantSidePanelTab[];
    activeTabId: string | null;
    onActivateTab: (id: string) => void;
    onCloseTab: (id: string) => void;
    onCloseAll: () => void;
    onReorderTabs?: (
        draggedTabId: string,
        targetTabId: string,
        position: AssistantTabDropPosition,
    ) => void;
    /**
     * Parent-driven reloading flag per document. Download buttons in
     * DocPanel show a spinner iff this returns true for the tab's
     * documentId. Used to signal "accept/reject in flight".
     */
    isEditorReloading?: (documentId: string) => boolean;
    /**
     * True while an accept/reject for this exact edit is in flight.
     * Disables the panel's Accept/Reject buttons for only the edit
     * currently being resolved — sibling edits stay clickable.
     */
    isEditReloading?: (editId: string) => boolean;
    onEditResolveStart?: (args: {
        editId: string;
        documentId: string;
        verb: "accept" | "reject";
    }) => void;
    onEditResolved?: (args: {
        editId: string;
        documentId: string;
        status: "accepted" | "rejected";
        versionId: string | null;
        downloadUrl: string | null;
    }) => void;
    onEditError?: (args: {
        editId: string;
        documentId: string;
        versionId: string | null;
        message: string;
    }) => void;
    onWarningDismiss?: (tabId: string) => void;
    onScrollChange?: (tabId: string, scrollTop: number) => void;
}

const MIN_WIDTH = 300;
const MAX_WIDTH_OFFSET = 56; // sidebar width
const MIN_CHAT_WIDTH = 400;
function maxPanelWidth() {
    if (typeof window === "undefined") return 600;
    return Math.max(
        MIN_WIDTH,
        window.innerWidth - MAX_WIDTH_OFFSET - MIN_CHAT_WIDTH,
    );
}

function tabTitle(tab: AssistantSidePanelTab): string {
    return tab.document.title;
}

export function AssistantSidePanel({
    tabs,
    activeTabId,
    onActivateTab,
    onCloseTab,
    onCloseAll,
    onReorderTabs,
    isEditorReloading,
    isEditReloading,
    onEditResolveStart,
    onEditResolved,
    onEditError,
    onWarningDismiss,
    onScrollChange,
}: Props) {
    const panelRef = useRef<HTMLDivElement>(null);
    const [panelWidth, setPanelWidth] = useState(() =>
        typeof window !== "undefined"
            ? Math.min(
                  maxPanelWidth(),
                  Math.round((window.innerWidth - MAX_WIDTH_OFFSET) / 2),
              )
            : 600,
    );

    const dragStartX = useRef<number>(0);
    const dragStartWidth = useRef<number>(0);
    const draggedTabIdRef = useRef<string | null>(null);
    const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
    const [dropTarget, setDropTarget] = useState<{
        tabId: string;
        position: AssistantTabDropPosition;
    } | null>(null);

    const clearTabDrag = useCallback(() => {
        draggedTabIdRef.current = null;
        setDraggedTabId(null);
        setDropTarget(null);
    }, []);

    const onMouseDown = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            dragStartX.current = e.clientX;
            dragStartWidth.current =
                panelRef.current?.offsetWidth ?? panelWidth;

            const onMouseMove = (ev: MouseEvent) => {
                const delta = dragStartX.current - ev.clientX;
                setPanelWidth(
                    Math.min(
                        maxPanelWidth(),
                        Math.max(MIN_WIDTH, dragStartWidth.current + delta),
                    ),
                );
            };
            const onMouseUp = () => {
                document.removeEventListener("mousemove", onMouseMove);
                document.removeEventListener("mouseup", onMouseUp);
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
            };

            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
        },
        [panelWidth],
    );

    useEffect(() => {
        const onResize = () => {
            setPanelWidth((width) =>
                Math.min(maxPanelWidth(), Math.max(MIN_WIDTH, width)),
            );
        };
        window.addEventListener("resize", onResize);
        onResize();
        return () => window.removeEventListener("resize", onResize);
    }, []);

    const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null;
    if (!active) return null;
    const lastTab = tabs[tabs.length - 1];

    return (
        <div
            ref={panelRef}
            className={cn(
                "relative flex h-full w-full shrink-0 flex-col md:my-3 md:mr-3 md:h-[calc(100%-1.5rem)] md:w-[var(--assistant-panel-width)]",
                "rounded-2xl backdrop-blur-2xl",
                LIQUID_GLASS_FLOAT_CLASS,
                "overflow-hidden",
            )}
            style={
                {
                    "--assistant-panel-width": `${panelWidth}px`,
                } as CSSProperties
            }
        >
            {/* Drag handle */}
            <div
                onMouseDown={onMouseDown}
                className={cn(
                    "absolute left-0 top-0 z-10 hidden h-full w-1 cursor-col-resize transition-colors md:block",
                    "hover:bg-blue-400/70",
                )}
                style={{ marginLeft: -2 }}
            />

            {/* Tab strip (Chrome-style) */}
            <div
                className={cn(
                    "document-tab-strip flex items-end gap-1 pt-2",
                )}
            >
                <div className="flex-1 flex items-end gap-1 overflow-hidden px-2">
                    {tabs.map((tab) => {
                        const isActive = tab.id === active.id;
                        const showVersionBadge =
                            typeof tab.document.version_number === "number" &&
                            Number.isFinite(tab.document.version_number) &&
                            tab.document.version_number > 1;
                        const title = tabTitle(tab);
                        return (
                            <div
                                key={tab.id}
                                draggable={!!onReorderTabs && tabs.length > 1}
                                onDragStart={(event) => {
                                    if (!onReorderTabs) return;
                                    draggedTabIdRef.current = tab.id;
                                    setDraggedTabId(tab.id);
                                    event.dataTransfer.effectAllowed = "move";
                                    event.dataTransfer.setData(
                                        "text/plain",
                                        tab.id,
                                    );
                                }}
                                onDragOver={(event) => {
                                    const draggedId =
                                        draggedTabIdRef.current ??
                                        event.dataTransfer.getData(
                                            "text/plain",
                                        );
                                    if (!onReorderTabs || !draggedId) {
                                        return;
                                    }
                                    if (draggedId === tab.id) {
                                        setDropTarget(null);
                                        return;
                                    }
                                    event.preventDefault();
                                    event.dataTransfer.dropEffect = "move";
                                    const rect =
                                        event.currentTarget.getBoundingClientRect();
                                    const position =
                                        event.clientX <
                                        rect.left + rect.width / 2
                                            ? "before"
                                            : "after";
                                    setDropTarget((current) =>
                                        current?.tabId === tab.id &&
                                        current.position === position
                                            ? current
                                            : { tabId: tab.id, position },
                                    );
                                }}
                                onDrop={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    const draggedId =
                                        draggedTabIdRef.current ??
                                        event.dataTransfer.getData(
                                            "text/plain",
                                        );
                                    if (
                                        onReorderTabs &&
                                        draggedId &&
                                        draggedId !== tab.id
                                    ) {
                                        const rect =
                                            event.currentTarget.getBoundingClientRect();
                                        onReorderTabs(
                                            draggedId,
                                            tab.id,
                                            event.clientX <
                                                rect.left + rect.width / 2
                                                ? "before"
                                                : "after",
                                        );
                                    }
                                    clearTabDrag();
                                }}
                                onDragEnd={clearTabDrag}
                                onClick={() => onActivateTab(tab.id)}
                                data-active={isActive ? "true" : "false"}
                                className={cn(
                                    "document-tab group relative flex items-center gap-1.5 pl-3 pr-1.5 h-7 min-w-0 max-w-[220px] rounded-t-lg cursor-pointer select-none transition-colors",
                                    isActive ? "z-20" : "z-10",
                                    onReorderTabs && tabs.length > 1
                                        ? "cursor-grab active:cursor-grabbing"
                                        : "",
                                    draggedTabId === tab.id ? "opacity-55" : "",
                                )}
                            >
                                {dropTarget?.tabId === tab.id &&
                                    draggedTabId !== tab.id && (
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
                                    {tab.document.type === "case" ||
                                    tab.document.type === "legislation" ? (
                                        <Image
                                            src={
                                                tab.document.type === "case"
                                                    ? "/icons/legal-sources/case-law.svg"
                                                    : "/icons/legal-sources/legislation.svg"
                                            }
                                            alt=""
                                            aria-hidden="true"
                                            width={14}
                                            height={14}
                                            className="h-3.5 w-3.5 shrink-0 object-contain"
                                        />
                                    ) : (
                                        <FileTypeIcon
                                            fileType={tab.document.title}
                                            className="h-3.5 w-3.5 shrink-0"
                                        />
                                    )}
                                    <span
                                        className={`min-w-0 flex-1 truncate text-xs ${isActive ? "font-medium" : "font-normal"}`}
                                        title={title}
                                    >
                                        {title}
                                    </span>
                                    {showVersionBadge && (
                                        <VersionChip
                                            n={tab.document.version_number}
                                            size="sm"
                                        />
                                    )}
                                </div>
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onCloseTab(tab.id);
                                    }}
                                    className="shrink-0 rounded-full p-0.5 text-gray-400 hover:text-gray-700"
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            </div>
                        );
                    })}
                    <div
                        className="h-7 min-w-4 flex-1"
                        onDragOver={(event) => {
                            const draggedId =
                                draggedTabIdRef.current ??
                                event.dataTransfer.getData("text/plain");
                            if (!onReorderTabs || !draggedId) return;

                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                            setDropTarget(
                                draggedId === lastTab.id
                                    ? null
                                    : {
                                          tabId: lastTab.id,
                                          position: "after",
                                      },
                            );
                        }}
                        onDrop={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            const draggedId =
                                draggedTabIdRef.current ??
                                event.dataTransfer.getData("text/plain");
                            if (
                                onReorderTabs &&
                                draggedId &&
                                draggedId !== lastTab.id
                            ) {
                                onReorderTabs(draggedId, lastTab.id, "after");
                            }
                            clearTabDrag();
                        }}
                    />
                </div>
                <button
                    type="button"
                    onClick={onCloseAll}
                    className="mr-1 shrink-0 self-center rounded-lg px-1.5 pb-1.5 text-gray-400 hover:text-gray-700"
                    aria-label="Close panel"
                    title="Close panel"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>

            {/* Tab bodies — all mounted, inactive ones hidden. Each tab
                preserves its state (scroll, docx-preview render, etc.)
                when inactive. */}
            <div className="flex-1 min-h-0 relative">
                {tabs.map((tab) => {
                    const isActive = tab.id === active.id;
                    const mode: DocPanelMode =
                        tab.kind === "citation"
                            ? {
                                  kind: "citation",
                                  citation: tab.citation,
                              }
                            : tab.kind === "edit"
                              ? {
                                    kind: "edit",
                                    edit: tab.edit,
                                    changeNumber: tab.changeNumber,
                                    isEditReloading:
                                        isEditReloading?.(tab.edit.edit_id) ??
                                        false,
                                    onResolveStart: onEditResolveStart,
                                    onResolved: onEditResolved,
                                    onError: onEditError,
                                }
                              : { kind: "document" };
                    return (
                        <div
                            key={tab.id}
                            className={`absolute inset-0 flex flex-col ${isActive ? "" : "invisible pointer-events-none"}`}
                            aria-hidden={!isActive}
                            inert={!isActive}
                        >
                            <DocPanel
                                active={isActive}
                                document={tab.document}
                                mode={mode}
                                isReloading={
                                    isEditorReloading?.(
                                        tab.document.document_id,
                                    ) ?? false
                                }
                                compactActions={panelWidth < 600}
                                warning={tab.warning ?? null}
                                onWarningDismiss={() =>
                                    onWarningDismiss?.(tab.id)
                                }
                                initialScrollTop={tab.initialScrollTop ?? null}
                                onScrollChange={(scrollTop) =>
                                    onScrollChange?.(tab.id, scrollTop)
                                }
                            />
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
