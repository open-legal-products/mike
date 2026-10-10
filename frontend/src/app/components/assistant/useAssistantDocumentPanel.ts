"use client";

import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction,
} from "react";
import { flushSync } from "react-dom";
import { useSidebar } from "@/app/contexts/SidebarContext";
import { invalidateDocxBytes } from "@/app/hooks/useFetchDocxBytes";
import {
    reorderAssistantSidePanelTabs,
    upsertAssistantSidePanelTab,
    type AssistantSidePanelTab,
    type AssistantTabDropPosition,
} from "./AssistantSidePanel";
import type { Document } from "../shared/types";

const ASSISTANT_PANEL_TRANSITION_MS = 500;
const MOBILE_BREAKPOINT_PX = 768;

function isSmallScreen() {
    return (
        typeof window !== "undefined" &&
        window.innerWidth < MOBILE_BREAKPOINT_PX
    );
}

/** What the document panel needs from a chat shown beside it. */
export type AssistantDocumentPanelPane = {
    /** Whether the reader may change this chat's documents. */
    canWrite: boolean;
    chatLoading: boolean;
    /** Attaches a document to this chat's composer. */
    addDocument: (document: Document) => void;
    /** Opens a document in the panel, reporting failures in this chat. */
    openDocument: (document: Document) => void;
};

/**
 * The assistant's document side panel: its tabs, whether it is open, and the
 * in-flight state of the tracked changes shown in it.
 *
 * One panel serves every chat on the page, so this state sits above the chat
 * columns. Each column registers itself as a pane; the panel sends "Add to
 * chat" to the pane the reader last used.
 */
export function useAssistantDocumentPanel() {
    const { setSidebarOpen } = useSidebar();
    const [tabs, setTabs] = useState<AssistantSidePanelTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [panelMounted, setPanelMounted] = useState(false);
    const [panelVisible, setPanelVisible] = useState(false);
    const [reloadingDocIds, setReloadingDocIds] = useState<Set<string>>(
        () => new Set(),
    );
    // Per-edit in-flight set — disables Accept/Reject on only the one
    // edit currently being resolved, so sibling edits in the same message
    // (and their twins in DocumentContent) stay clickable.
    const [reloadingEditIds, setReloadingEditIds] = useState<Set<string>>(
        () => new Set(),
    );
    const [resolvedEditStatuses, setResolvedEditStatuses] = useState<
        Record<string, "accepted" | "rejected">
    >({});
    const [panes, setPanes] = useState<
        Record<string, AssistantDocumentPanelPane>
    >({});
    // Which chat the reader last used. A ref, not state: it is set as a press
    // begins, and a render between the press and its click would replace the
    // control being clicked (a citation pill) and lose the click.
    const activePaneIdRef = useRef<string | null>(null);
    const panesRef = useRef(panes);
    useEffect(() => {
        panesRef.current = panes;
    }, [panes]);
    const setActivePane = useCallback((paneId: string) => {
        activePaneIdRef.current = paneId;
    }, []);
    /**
     * The chat that "Add to chat" and "Open Documents" act on: the one the
     * reader last used, or another that can take the document if it cannot.
     */
    const getTargetPane = useCallback(
        (needsWrite = false): AssistantDocumentPanelPane | null => {
            const all = Object.values(panesRef.current);
            const usable = (pane: AssistantDocumentPanelPane | undefined) =>
                pane && (!needsWrite || (pane.canWrite && !pane.chatLoading))
                    ? pane
                    : null;
            const active = activePaneIdRef.current
                ? panesRef.current[activePaneIdRef.current]
                : undefined;
            return (
                usable(active) ??
                all.find((pane) => usable(pane)) ??
                active ??
                all[0] ??
                null
            );
        },
        [],
    );
    const panelCloseTimerRef = useRef<number | null>(null);

    const show = useCallback(() => {
        if (panelCloseTimerRef.current !== null) {
            window.clearTimeout(panelCloseTimerRef.current);
            panelCloseTimerRef.current = null;
        }
        flushSync(() => {
            setSidebarOpen(false);
        });

        if (panelMounted) {
            setPanelVisible(true);
            return;
        }

        setPanelVisible(false);
        setPanelMounted(true);
        requestAnimationFrame(() =>
            requestAnimationFrame(() => setPanelVisible(true)),
        );
    }, [panelMounted, setSidebarOpen]);

    useEffect(
        () => () => {
            if (panelCloseTimerRef.current !== null) {
                window.clearTimeout(panelCloseTimerRef.current);
            }
        },
        [],
    );

    const closeAllTabs = useCallback(() => {
        if (panelCloseTimerRef.current !== null) {
            window.clearTimeout(panelCloseTimerRef.current);
        }
        setPanelVisible(false);
        panelCloseTimerRef.current = window.setTimeout(() => {
            panelCloseTimerRef.current = null;
            setPanelMounted(false);
            if (!isSmallScreen()) setSidebarOpen(true);
            setTabs([]);
            setActiveTabId(null);
        }, ASSISTANT_PANEL_TRANSITION_MS);
    }, [setSidebarOpen]);

    const closeTab = useCallback(
        (id: string) => {
            // Closing the last tab leaves the panel open on its "Open Documents"
            // placeholder; only the panel's own close control dismisses it.
            setTabs((prev) => {
                const next = prev.filter((t) => t.id !== id);
                if (activeTabId === id) {
                    const idx = prev.findIndex((t) => t.id === id);
                    const neighbour = next[idx] ?? next[idx - 1] ?? next[0];
                    setActiveTabId(neighbour?.id ?? null);
                }
                return next;
            });
        },
        [activeTabId],
    );

    const reorderTabs = useCallback(
        (
            draggedTabId: string,
            targetTabId: string,
            position: AssistantTabDropPosition,
        ) => {
            setTabs((current) =>
                reorderAssistantSidePanelTabs(
                    current,
                    draggedTabId,
                    targetTabId,
                    position,
                ),
            );
        },
        [],
    );

    /**
     * One tab per document. New citations, edits and version selections update
     * that tab; changing versions resets version-specific scroll and warnings.
     */
    const upsertTab = useCallback(
        (tab: AssistantSidePanelTab) => {
            setTabs((prev) => upsertAssistantSidePanelTab(prev, tab));
            setActiveTabId(tab.id);
            show();
        },
        [show],
    );

    const handleEditResolveStart = useCallback(
        (args: {
            editId: string;
            documentId: string;
            verb: "accept" | "reject";
        }) => {
            setReloadingDocIds((prev) => {
                if (prev.has(args.documentId)) return prev;
                const next = new Set(prev);
                next.add(args.documentId);
                return next;
            });
            setReloadingEditIds((prev) => {
                if (prev.has(args.editId)) return prev;
                const next = new Set(prev);
                next.add(args.editId);
                return next;
            });
        },
        [],
    );

    const handleEditResolved = useCallback(
        (args: {
            editId: string;
            documentId: string;
            status: "accepted" | "rejected";
            versionId: string | null;
            downloadUrl: string | null;
        }) => {
            setResolvedEditStatuses((prev) => ({
                ...prev,
                [args.editId]: args.status,
            }));
            setReloadingDocIds((prev) => {
                if (!prev.has(args.documentId)) return prev;
                const next = new Set(prev);
                next.delete(args.documentId);
                return next;
            });
            setReloadingEditIds((prev) => {
                if (!prev.has(args.editId)) return prev;
                const next = new Set(prev);
                next.delete(args.editId);
                return next;
            });
            // Propagate the new status onto any open edit-tab for this
            // edit so DocumentContent's Accept/Reject buttons flip and disable
            // (their sync effect keys off edit.status). Without this, a
            // resolve triggered from the inline EditCard or BulkEditActions
            // leaves the panel buttons looking live.
            setTabs((prev) =>
                prev.map((t) =>
                    t.kind === "edit" && t.edit.edit_id === args.editId
                        ? {
                              ...t,
                              edit: { ...t.edit, status: args.status },
                          }
                        : t,
                ),
            );
            // Accept/reject mutates bytes for this document's current
            // version; drop the cache so the next DocxView render (or an
            // explicit re-open) fetches the fresh file.
            invalidateDocxBytes(args.documentId);
        },
        [],
    );

    const patchTab = useCallback(
        (
            tabId: string,
            patch: {
                warning?: string | null;
                initialScrollTop?: number | null;
            },
        ) => {
            setTabs((prev) => {
                const idx = prev.findIndex((t) => t.id === tabId);
                if (idx < 0) return prev;
                const copy = prev.slice();
                copy[idx] = { ...copy[idx], ...patch };
                return copy;
            });
        },
        [],
    );

    const handleEditError = useCallback(
        (args: {
            editId?: string;
            documentId: string;
            versionId?: string | null;
            message: string;
        }) => {
            // Surface the warning on every tab tied to this document.
            setTabs((prev) =>
                prev.map((t) =>
                    t.document.document_id === args.documentId
                        ? { ...t, warning: args.message }
                        : t,
                ),
            );
            setReloadingDocIds((prev) => {
                if (!prev.has(args.documentId)) return prev;
                const next = new Set(prev);
                next.delete(args.documentId);
                return next;
            });
            if (args.editId) {
                setReloadingEditIds((prev) => {
                    if (!prev.has(args.editId!)) return prev;
                    const next = new Set(prev);
                    next.delete(args.editId!);
                    return next;
                });
            }
        },
        [],
    );

    const handleWarningDismiss = useCallback(
        (tabId: string) => {
            patchTab(tabId, { warning: null });
        },
        [patchTab],
    );

    /**
     * Dismisses a tab's citation quote or tracked change, leaving the document
     * open. This drops the tab to a plain document view rather than hiding the
     * section inside the panel: reopening the same citation upserts an
     * identical tab, which by design produces no prop change, so a panel-local
     * dismissal would leave the user unable to get the quote back.
     */
    const handleCloseAnnotation = useCallback((tabId: string) => {
        setTabs((prev) => {
            const index = prev.findIndex((tab) => tab.id === tabId);
            if (index < 0 || prev[index].kind === "document") return prev;
            const { id, document, warning, initialScrollTop } = prev[index];
            const next = prev.slice();
            next[index] = {
                kind: "document",
                id,
                document,
                warning,
                initialScrollTop,
            };
            return next;
        });
    }, []);

    const handleScrollChange = useCallback(
        (tabId: string, scrollTop: number) => {
            patchTab(tabId, { initialScrollTop: scrollTop });
        },
        [patchTab],
    );

    useEffect(() => {
        if (panelMounted && window.innerWidth < MOBILE_BREAKPOINT_PX) {
            document.body.style.overflow = "hidden";
        } else {
            document.body.style.overflow = "unset";
        }
        return () => {
            document.body.style.overflow = "unset";
        };
    }, [panelMounted]);

    /** Returns the function that takes the pane off the page again. */
    const registerPane = useCallback(
        (paneId: string, pane: AssistantDocumentPanelPane) => {
            setPanes((current) => ({ ...current, [paneId]: pane }));
            return () =>
                setPanes((current) => {
                    if (current[paneId] !== pane) return current;
                    const next = { ...current };
                    delete next[paneId];
                    return next;
                });
        },
        [],
    );

    const paneList = Object.values(panes);

    return useMemo(
        () => ({
            tabs,
            setTabs: setTabs as Dispatch<
                SetStateAction<AssistantSidePanelTab[]>
            >,
            activeTabId,
            setActiveTabId,
            panelMounted,
            panelVisible,
            show,
            closeAllTabs,
            closeTab,
            reorderTabs,
            upsertTab,
            reloadingDocIds,
            reloadingEditIds,
            resolvedEditStatuses,
            handleEditResolveStart,
            handleEditResolved,
            handleEditError,
            handleWarningDismiss,
            handleCloseAnnotation,
            handleScrollChange,
            registerPane,
            setActivePane,
            getTargetPane,
            /** Whether any chat on the page lets the reader change documents. */
            canWrite: paneList.some((pane) => pane.canWrite),
            /** Whether any chat on the page can take a document right now. */
            canAddToChat: paneList.some(
                (pane) => pane.canWrite && !pane.chatLoading,
            ),
            paneCount: paneList.length,
        }),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- paneList derives from panes
        [
            tabs,
            activeTabId,
            panelMounted,
            panelVisible,
            show,
            closeAllTabs,
            closeTab,
            reorderTabs,
            upsertTab,
            reloadingDocIds,
            reloadingEditIds,
            resolvedEditStatuses,
            handleEditResolveStart,
            handleEditResolved,
            handleEditError,
            handleWarningDismiss,
            handleCloseAnnotation,
            handleScrollChange,
            registerPane,
            setActivePane,
            getTargetPane,
            panes,
        ],
    );
}

export type AssistantDocumentPanel = ReturnType<
    typeof useAssistantDocumentPanel
>;
