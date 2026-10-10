"use client";

import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type CSSProperties,
} from "react";
import { useDocumentViewers } from "@/app/hooks/useDocumentViewers";
import { useDocumentPermissions } from "@/app/hooks/useDocumentPermissions";
import { type DocumentActions } from "../shared/DocumentTabActions";
import type { DocumentVersion } from "@/app/lib/mikeApi";
import Image from "next/image";
import { BookOpenText } from "lucide-react";
import { DocumentContent, type DocumentContentMode } from "@/app/components/shared/DocumentContent";
import { DocumentTabBar } from "../shared/DocumentTabBar";
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
// Each document has one tab. Its shared title row selects the version;
// citation pills and edit cards select the annotation within that tab.

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

/** One tab per document; the title row selects the displayed version. */
export function assistantSidePanelTabId(document: PanelDocument): string {
    return document.document_id;
}

export function mergeAssistantSidePanelTab(
    existing: AssistantSidePanelTab,
    incoming: AssistantSidePanelTab,
): AssistantSidePanelTab {
    if (
        existing.id !== incoming.id ||
        existing.document.version_id !== incoming.document.version_id ||
        existing.document.version_number !== incoming.document.version_number
    ) {
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
    return reorderTabs(
        tabs,
        draggedTabId,
        targetTabId,
        position,
        (tab) => tab.id,
    );
}

interface Props {
    tabs: AssistantSidePanelTab[];
    /** Whether the viewer may edit the documents; read-only otherwise. */
    canEdit?: boolean;
    activeTabId: string | null;
    onActivateTab: (id: string) => void;
    onCloseTab: (id: string) => void;
    onCloseAll: () => void;
    onVersionChange?: (tabId: string, version: DocumentVersion) => void;
    documentActions?: (document: PanelDocument) => DocumentActions;
    onReorderTabs?: (
        draggedTabId: string,
        targetTabId: string,
        position: AssistantTabDropPosition,
    ) => void;
    /**
     * Parent-driven reloading flag per document. Download buttons in
     * DocumentContent show a spinner iff this returns true for the tab's
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
    /**
     * Drops a tab back to a plain document view, dismissing the citation quote
     * or tracked change shown above the viewer.
     */
    onCloseAnnotation?: (tabId: string) => void;
    onScrollChange?: (tabId: string, scrollTop: number) => void;
    /**
     * Offered when the panel has no tabs. Without it an empty panel renders
     * nothing; with it the panel stays open on an "Open Documents" placeholder.
     */
    onOpenDocuments?: () => void;
    /**
     * How many chats share the page with the panel. Each keeps its minimum
     * width, and beside two chats the panel opens narrow rather than at half
     * the page.
     */
    chatCount?: number;
}

const MIN_WIDTH = 300;
const MAX_WIDTH_OFFSET = 56; // sidebar width
const MIN_CHAT_WIDTH = 400;
const TWO_CHAT_WIDTH = 360;

/** The widest the panel may be while every chat keeps its minimum width. */
export function maxAssistantSidePanelWidth(
    viewportWidth: number,
    chatCount: number,
): number {
    return Math.max(
        MIN_WIDTH,
        viewportWidth - MAX_WIDTH_OFFSET - MIN_CHAT_WIDTH * chatCount,
    );
}

/** The width the panel opens at: half the page, or narrow beside two chats. */
export function defaultAssistantSidePanelWidth(
    viewportWidth: number,
    chatCount: number,
): number {
    return Math.min(
        maxAssistantSidePanelWidth(viewportWidth, chatCount),
        chatCount > 1
            ? TWO_CHAT_WIDTH
            : Math.round((viewportWidth - MAX_WIDTH_OFFSET) / 2),
    );
}

function maxPanelWidth(chatCount: number) {
    if (typeof window === "undefined") return 600;
    return maxAssistantSidePanelWidth(window.innerWidth, chatCount);
}

export function AssistantSidePanel({
    tabs,
    canEdit = false,
    activeTabId,
    onActivateTab,
    onCloseTab,
    onCloseAll,
    onVersionChange,
    documentActions,
    onReorderTabs,
    isEditorReloading,
    isEditReloading,
    onEditResolveStart,
    onEditResolved,
    onEditError,
    onWarningDismiss,
    onCloseAnnotation,
    onScrollChange,
    onOpenDocuments,
    chatCount = 1,
}: Props) {
    const panelRef = useRef<HTMLDivElement>(null);
    const permissions = useDocumentPermissions(tabs.filter((tab) => !["case", "legislation"].includes(tab.document.type)).map((tab) => tab.document.document_id), canEdit);
    const viewers = useDocumentViewers();
    // One width beside a single chat and another beside two, so closing the
    // second chat gives the panel back the width it had before.
    const split = chatCount > 1;
    const [panelWidths, setPanelWidths] = useState(() =>
        typeof window !== "undefined"
            ? {
                  single: defaultAssistantSidePanelWidth(window.innerWidth, 1),
                  split: defaultAssistantSidePanelWidth(window.innerWidth, 2),
              }
            : { single: 600, split: TWO_CHAT_WIDTH },
    );
    const panelWidth = split ? panelWidths.split : panelWidths.single;

    const dragStartX = useRef<number>(0);
    const dragStartWidth = useRef<number>(0);
    const onMouseDown = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            dragStartX.current = e.clientX;
            dragStartWidth.current =
                panelRef.current?.offsetWidth ?? panelWidth;

            const onMouseMove = (ev: MouseEvent) => {
                const delta = dragStartX.current - ev.clientX;
                const width = Math.min(
                    maxPanelWidth(chatCount),
                    Math.max(MIN_WIDTH, dragStartWidth.current + delta),
                );
                setPanelWidths((current) =>
                    split
                        ? { ...current, split: width }
                        : { ...current, single: width },
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
        [panelWidth, chatCount, split],
    );

    useEffect(() => {
        const fit = (width: number, chats: number) =>
            Math.min(maxPanelWidth(chats), Math.max(MIN_WIDTH, width));
        const onResize = () => {
            setPanelWidths((current) => {
                const next = {
                    single: fit(current.single, 1),
                    split: fit(current.split, 2),
                };
                return next.single === current.single &&
                    next.split === current.split
                    ? current
                    : next;
            });
        };
        window.addEventListener("resize", onResize);
        onResize();
        return () => window.removeEventListener("resize", onResize);
    }, []);

    const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null;
    if (!active && !onOpenDocuments) return null;

    return (
        <div
            ref={panelRef}
            className={cn(
                "relative flex h-full w-full shrink-0 flex-col md:my-3 md:mr-3 md:h-[calc(100%-1.5rem)] md:w-[var(--assistant-panel-width)]",
                "rounded-2xl",
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

            <DocumentTabBar
                label="Assistant documents"
                idPrefix="assistant-document"
                activeTabId={active?.id ?? null}
                onActivate={onActivateTab}
                onClose={(id) => viewers.requestClose([id], () => onCloseTab(id))}
                onClosePanel={() => viewers.requestClose(tabs.map((tab) => tab.id), onCloseAll)}
                onAdd={onOpenDocuments}
                addLabel="Open Documents"
                onReorder={onReorderTabs}
                tabs={tabs.map((tab) => {
                    const isLegalSource =
                        tab.document.type === "case" ||
                        tab.document.type === "legislation";
                    const actions = isLegalSource
                        ? undefined
                        : documentActions?.(tab.document);
                    return {
                        id: tab.id,
                        title: tab.document.title,
                        versionNumber: tab.document.version_number,
                        icon: isLegalSource ? (
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
                        ) : undefined,
                        actions: {
                            ...actions,
                            onRename: permissions(tab.document.document_id).canEdit ? actions?.onRename : undefined,
                            onDownload: isLegalSource ? undefined : () => viewers.download(tab.id, tab.document.document_id, tab.document.version_id, tab.document.title),
                            onDelete: permissions(tab.document.document_id).canDelete ? actions?.onDelete : undefined,
                        },
                    };
                })}
            />

            {/* Tab bodies — all mounted, inactive ones hidden. Each tab
                preserves its state (scroll, DOCX renderer, etc.)
                when inactive. */}
            <div className="flex-1 min-h-0 relative">
                {!active && onOpenDocuments ? (
                    <div className="flex h-full items-center justify-center">
                        <button
                            type="button"
                            onClick={onOpenDocuments}
                            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-gray-500 transition-colors hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                        >
                            <BookOpenText aria-hidden="true" className="h-4 w-4" />
                            Open Documents
                        </button>
                    </div>
                ) : null}
                {tabs.map((tab) => {
                    const isActive = tab.id === active?.id;
                    const mode: DocumentContentMode =
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
                            role="tabpanel"
                            id={`assistant-document-panel-${tab.id}`}
                            aria-labelledby={`assistant-document-tab-${tab.id}`}
                            className={`absolute inset-0 flex flex-col ${isActive ? "" : "invisible pointer-events-none"}`}
                            aria-hidden={!isActive}
                            inert={!isActive}
                        >
                            <DocumentContent
                                showToolbarToggle
                                canEdit={permissions(tab.document.document_id).canEdit}
                                onDownloadReady={(download) => viewers.registerDownload(tab.id, download)}
                                onCloseGuardReady={(guard) => viewers.registerCloseGuard(tab.id, guard)}
                                active={isActive}
                                onVersionChange={
                                    onVersionChange
                                        ? (version) =>
                                              viewers.requestClose([tab.id], () => onVersionChange(tab.id, version))
                                        : undefined
                                }
                                document={tab.document}
                                mode={mode}
                                isReloading={
                                    isEditorReloading?.(
                                        tab.document.document_id,
                                    ) ?? false
                                }
                                warning={tab.warning ?? null}
                                onWarningDismiss={() =>
                                    onWarningDismiss?.(tab.id)
                                }
                                onCloseAnnotation={
                                    tab.kind !== "document" && onCloseAnnotation
                                        ? () => onCloseAnnotation(tab.id)
                                        : undefined
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
            {viewers.confirmation}
        </div>
    );
}
