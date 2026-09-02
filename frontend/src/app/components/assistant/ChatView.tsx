"use client";

import { useCallback, useState, useRef, useEffect } from "react";
import { flushSync } from "react-dom";
import { ArrowDown } from "lucide-react";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { ChatInput } from "./ChatInput";
import type { ChatInputHandle } from "./ChatInput";
import { AskInputPopup } from "./AskInputPopup";
import {
    AssistantSidePanel,
    assistantSidePanelTabId,
    reorderAssistantSidePanelTabs,
    upsertAssistantSidePanelTab,
    type AssistantTabDropPosition,
    type AssistantSidePanelTab,
} from "./AssistantSidePanel";
import { AssistantWorkflowModal } from "./AssistantWorkflowModal";
import type {
    AssistantEvent,
    Citation,
    EditAnnotation,
    Message,
} from "../shared/types";
import {
    panelDocumentFromCaseEvent,
    panelDocumentFromCitation,
    panelDocumentType,
} from "../shared/types";
import { useSidebar } from "@/app/contexts/SidebarContext";
import { invalidateDocxBytes } from "@/app/hooks/useFetchDocxBytes";
import { resolvePanelDocumentVersion } from "./panelDocumentVersion";
import { LIQUID_GLASS_TRANSLUCENT_ACTION_CLASS } from "@/app/components/ui/liquid-surface";
import { useQuotableSelection } from "@/app/hooks/useQuotableSelection";
import { QuoteSelectionPopup } from "@/app/components/shared/QuoteSelectionPopup";

interface Props {
    chatId?: string | null;
    chatModel?: string | null;
    chatReasoningLevel?: NonNullable<Message["reasoning"]> | null;
    messages: Message[];
    isResponseLoading: boolean;
    handleChat: (
        message: Message,
        opts?: {
            displayedDoc?: { filename: string; documentId: string } | null;
            askInputsResponse?: Extract<
                AssistantEvent,
                { type: "ask_inputs_response" }
            >;
        },
    ) => Promise<string | null>;
    cancel: () => void;
}

const ASSISTANT_PANEL_TRANSITION_MS = 500;
const MOBILE_BREAKPOINT_PX = 768;
const DEFAULT_ASSISTANT_BOTTOM_PADDING = 116;
const SCROLL_BUTTON_INPUT_GAP = 16;
const CHAT_INPUT_BOTTOM_OFFSET = 12;

function isSmallScreen() {
    return (
        typeof window !== "undefined" &&
        window.innerWidth < MOBILE_BREAKPOINT_PX
    );
}

export function ChatView({
    chatId,
    chatModel,
    chatReasoningLevel,
    messages,
    isResponseLoading,
    handleChat,
    cancel,
}: Props) {
    const [tabs, setTabs] = useState<AssistantSidePanelTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [panelMounted, setPanelMounted] = useState(false);
    const [panelVisible, setPanelVisible] = useState(false);
    const [workflowModalOpen, setWorkflowModalOpen] = useState(false);
    const [workflowModalInitialId, setWorkflowModalInitialId] = useState<
        string | undefined
    >();
    const [hiddenAskInputKeys, setHiddenAskInputKeys] = useState<Set<string>>(
        () => new Set(),
    );
    const [reloadingDocIds, setReloadingDocIds] = useState<Set<string>>(
        () => new Set(),
    );
    // Per-edit in-flight set — disables Accept/Reject on only the one
    // edit currently being resolved, so sibling edits in the same message
    // (and their twins in DocPanel) stay clickable.
    const [reloadingEditIds, setReloadingEditIds] = useState<Set<string>>(
        () => new Set(),
    );
    const { setSidebarOpen } = useSidebar();
    const panelCloseTimerRef = useRef<number | null>(null);
    const activeTab = tabs.find((tab) => tab.id === activeTabId);
    const activeCitation =
        activeTab?.kind === "citation" ? activeTab.citation : null;

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- reset per-chat UI state when switching chats
        setHiddenAskInputKeys(new Set());
    }, [chatId]);

    const showPanel = useCallback(() => {
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

    const restoreSidebarAfterPanelClose = useCallback(() => {
        if (!isSmallScreen()) setSidebarOpen(true);
    }, [setSidebarOpen]);

    useEffect(
        () => () => {
            if (panelCloseTimerRef.current !== null) {
                window.clearTimeout(panelCloseTimerRef.current);
            }
        },
        [],
    );

    const hidePanel = useCallback(
        (afterHidden: () => void) => {
            if (panelCloseTimerRef.current !== null) {
                window.clearTimeout(panelCloseTimerRef.current);
            }
            setPanelVisible(false);
            panelCloseTimerRef.current = window.setTimeout(() => {
                panelCloseTimerRef.current = null;
                afterHidden();
            }, ASSISTANT_PANEL_TRANSITION_MS);
        },
        [],
    );

    const unmountPanel = useCallback(
        (afterUnmount?: () => void) => {
            setPanelMounted(false);
            restoreSidebarAfterPanelClose();
            afterUnmount?.();
        },
        [restoreSidebarAfterPanelClose],
    );

    const closeAllTabs = useCallback(() => {
        hidePanel(() =>
            unmountPanel(() => {
                setTabs([]);
                setActiveTabId(null);
            }),
        );
    }, [hidePanel, unmountPanel]);

    const closeTab = useCallback(
        (id: string) => {
            setTabs((prev) => {
                const next = prev.filter((t) => t.id !== id);
                if (next.length === 0) {
                    hidePanel(() =>
                        unmountPanel(() => {
                            setActiveTabId(null);
                            setTabs([]);
                        }),
                    );
                    return prev;
                }
                if (activeTabId === id) {
                    const idx = prev.findIndex((t) => t.id === id);
                    const neighbour = next[idx] ?? next[idx - 1] ?? next[0];
                    setActiveTabId(neighbour?.id ?? null);
                }
                return next;
            });
        },
        [activeTabId, hidePanel, unmountPanel],
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
     * One tab per normalized document version. If a tab already exists,
     * the panel stays mounted and only the header-relevant fields swap
     * (kind, citation/edit, version, filename). Per-tab UI state — the
     * dismissable warning and the saved scroll position — is preserved
     * so switching headers doesn't blow away viewer state. If no tab
     * exists for the version, a new one is appended.
     */
    const upsertTab = useCallback(
        (tab: AssistantSidePanelTab) => {
            setTabs((prev) => upsertAssistantSidePanelTab(prev, tab));
            setActiveTabId(tab.id);
            showPanel();
        },
        [showPanel],
    );

    /**
     * Open a tab showing a single citation quote. Called from
     * AssistantMessage when the user clicks a numbered citation pill.
     */
    const openCitation = useCallback(
        async (citation: Citation, options?: { showQuotes?: boolean }) => {
            const showQuotes = options?.showQuotes ?? true;
            const document = await resolvePanelDocumentVersion(
                panelDocumentFromCitation(citation, showQuotes),
            );
            if (!document) return;
            if (!showQuotes) {
                upsertTab({
                    kind: "document",
                    id: assistantSidePanelTabId(document),
                    document,
                });
                return;
            }
            upsertTab({
                kind: "citation",
                id: assistantSidePanelTabId(document),
                document,
                citation,
            });
        },
        [upsertTab],
    );

    const openCase = useCallback(
        (citation: Extract<AssistantEvent, { type: "case_citation" }>) => {
            const document = panelDocumentFromCaseEvent(citation);
            if (!document) return;
            upsertTab({
                kind: "document",
                id: assistantSidePanelTabId(document),
                document,
            });
        },
        [upsertTab],
    );

    /**
     * Open a tab showing a single tracked change. Called from
     * AssistantMessage when the user clicks an EditCard's View button.
     */
    const openEditor = useCallback(
        (ann: EditAnnotation, filename: string, changeNumber?: number) => {
            const document = {
                document_id: ann.document_id,
                title: filename,
                type: panelDocumentType(filename),
                metadata: [],
                quotes: [],
                version_id: ann.version_id ?? null,
                version_number: ann.version_number ?? null,
            };
            upsertTab({
                kind: "edit",
                id: assistantSidePanelTabId(document),
                document,
                edit: ann,
                changeNumber,
            });
        },
        [upsertTab],
    );

    /**
     * Open a tab showing a document without targeting a specific
     * citation/edit — used by the download-card click.
     */
    const openDocument = useCallback(
        async (args: {
            documentId: string;
            filename: string;
            versionId: string | null;
            versionNumber: number | null;
        }) => {
            const document = await resolvePanelDocumentVersion({
                document_id: args.documentId,
                title: args.filename,
                type: panelDocumentType(args.filename),
                metadata: [],
                quotes: [],
                version_id: args.versionId,
                version_number: args.versionNumber,
            });
            if (!document) return;
            upsertTab({
                kind: "document",
                id: assistantSidePanelTabId(document),
                document,
            });
        },
        [upsertTab],
    );

    const [resolvedEditStatuses, setResolvedEditStatuses] = useState<
        Record<string, "accepted" | "rejected">
    >({});

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
            // edit so DocPanel's Accept/Reject buttons flip and disable
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

    const handleScrollChange = useCallback(
        (tabId: string, scrollTop: number) => {
            patchTab(tabId, { initialScrollTop: scrollTop });
        },
        [patchTab],
    );

    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const latestUserMessageRef = useRef<HTMLDivElement>(null);
    const chatInputRef = useRef<ChatInputHandle | null>(null);
    const measuredInputRef = useRef<HTMLDivElement>(null);
    // Seed "already in place" when messages exist at mount (a freshly created
    // chat arrives with its first message in hand). Otherwise the skeleton +
    // opacity-0 gate would flash the message out and fade it back in on every
    // remount. Existing chats mount with messages === [] and fetch async, so
    // they still start hidden and reveal once loaded.
    const hasScrolledRef = useRef(messages.length > 0);
    const [messagesVisible, setMessagesVisible] = useState(
        () => messages.length > 0,
    );
    const [showScrollButton, setShowScrollButton] = useState(false);
    const [inputHeight, setInputHeight] = useState(0);
    const [minHeight, setMinHeight] = useState("0px");

    useEffect(() => {
        const el = measuredInputRef.current;
        if (!el) return;
        const update = () => setInputHeight(el.offsetHeight);
        const observer = new ResizeObserver(update);
        observer.observe(el);
        update();
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (latestUserMessageRef.current) {
            const headerHeight = window.innerWidth < 768 ? 56 : 0;
            const messageGap = window.innerWidth < 768 ? 24 : 32;
            const paddingBottom = DEFAULT_ASSISTANT_BOTTOM_PADDING;
            const userMessageHeight = latestUserMessageRef.current.offsetHeight;
            setMinHeight(
                `calc(100dvh - ${headerHeight + messageGap * 3 + userMessageHeight + paddingBottom}px)`,
            );
        }
    }, [messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

    const updateScrollButton = useCallback(() => {
        const c = messagesContainerRef.current;
        if (!c) return;
        const isScrolledUp = c.scrollHeight - c.scrollTop - c.clientHeight > 10;
        setShowScrollButton(isScrolledUp && c.scrollHeight > c.clientHeight);
    }, []);

    useEffect(() => {
        const c = messagesContainerRef.current;
        if (!c) return;
        c.addEventListener("scroll", updateScrollButton);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- initial scroll-button state must be measured from the live DOM
        updateScrollButton();
        return () => c.removeEventListener("scroll", updateScrollButton);
    }, [messages, updateScrollButton]);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    const scrollLatestUserToTop = useCallback(() => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const container = messagesContainerRef.current;
                const element = latestUserMessageRef.current;
                if (!container || !element) return;
                container.scrollTo({
                    top: element.offsetTop - 24,
                    behavior: "smooth",
                });
            });
        });
    }, []);

    useEffect(() => {
        const last = messages[messages.length - 1];
        if (last?.role === "user") scrollLatestUserToTop();
    }, [messages, scrollLatestUserToTop]);

    useEffect(() => {
        if (isResponseLoading) scrollLatestUserToTop();
    }, [isResponseLoading, scrollLatestUserToTop]);

    useEffect(() => {
        if (messages.length === 0) {
            hasScrolledRef.current = false;
            // eslint-disable-next-line react-hooks/set-state-in-effect -- hide messages until scroll position is restored to avoid a visible jump
            setMessagesVisible(false);
        } else if (!hasScrolledRef.current) {
            const userMsgCount = messages.filter(
                (m) => m.role === "user",
            ).length;
            if (
                userMsgCount >= 2 &&
                latestUserMessageRef.current &&
                messagesContainerRef.current
            ) {
                setTimeout(() => {
                    const container = messagesContainerRef.current;
                    const element = latestUserMessageRef.current;
                    if (container && element) {
                        container.scrollTo({
                            top: element.offsetTop - 24,
                            behavior: "instant",
                        });
                    }
                    hasScrolledRef.current = true;
                    setMessagesVisible(true);
                }, 100);
            } else {
                hasScrolledRef.current = true;
                setMessagesVisible(true);
            }
        }
    }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (panelMounted && window.innerWidth < 768) {
            document.body.style.overflow = "hidden";
        } else {
            document.body.style.overflow = "unset";
        }
        return () => {
            document.body.style.overflow = "unset";
        };
    }, [panelMounted]);

    const rawActiveInput = (() => {
        for (
            let messageIndex = messages.length - 1;
            messageIndex >= 0;
            messageIndex--
        ) {
            const message = messages[messageIndex];
            if (message.role === "user") return null;
            if (message.role !== "assistant" || !message.events) continue;
            for (
                let eventIndex = message.events.length - 1;
                eventIndex >= 0;
                eventIndex--
            ) {
                const event = message.events[eventIndex];
                if (event.type === "ask_inputs_response") {
                    return null;
                }
                if (event.type === "ask_inputs") {
                    return {
                        key: `${messageIndex}-${eventIndex}`,
                        event,
                    };
                }
            }
        }
        return null;
    })();
    const activeInput =
        rawActiveInput && !hiddenAskInputKeys.has(rawActiveInput.key)
            ? rawActiveInput
            : null;

    const messagesBottomPadding = DEFAULT_ASSISTANT_BOTTOM_PADDING;

    // Highlighting inside an assistant response offers "Add to Chat". Disabled
    // while AskInputPopup has replaced the composer — there is no chip row to
    // attach the excerpt to.
    const { selection: quotableSelection, clear: clearQuotableSelection } =
        useQuotableSelection(messagesContainerRef, {
            enabled: activeInput === null,
        });

    const addQuotedExcerpt = useCallback(
        (text: string) => {
            chatInputRef.current?.addQuotedExcerpt(text);
            clearQuotableSelection();
        },
        [clearQuotableSelection],
    );

    return (
        <div className="h-full w-full flex relative">
            {/* Chat column */}
            <div className="flex min-w-0 flex-col h-full flex-1 relative">
                {/* Scrollable messages */}
                <div
                    ref={messagesContainerRef}
                    className="assistant-chat-message-fade flex-1 w-full overflow-y-auto"
                    style={{ scrollbarGutter: "stable both-edges" }}
                >
                    <div
                        className="w-full max-w-4xl mx-auto px-6 pt-6 md:px-8 md:pt-8 min-h-full flex flex-col relative"
                        style={{ paddingBottom: messagesBottomPadding }}
                    >
                        {!messagesVisible && (
                            <div className="space-y-6 md:space-y-8 w-full">
                                <div className="flex justify-end">
                                    <div className="bg-gray-100 rounded-2xl p-4 w-2/5">
                                        <div className="theme-shimmer h-4 bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded w-full" />
                                    </div>
                                </div>
                                <div className="space-y-3">
                                    {[1, 2, 3, 4].map((i) => (
                                        <div
                                            key={i}
                                            className={`theme-shimmer h-4 bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded ${i === 3 ? "w-5/6" : i === 4 ? "w-4/6" : "w-full"}`}
                                        />
                                    ))}
                                </div>
                            </div>
                        )}
                        <div
                            className="space-y-6 md:space-y-8 transition-opacity duration-150"
                            style={{ opacity: messagesVisible ? 1 : 0 }}
                        >
                            {(() => {
                                const lastUserIndex = messages
                                    .map((m) => m.role)
                                    .lastIndexOf("user");
                                const lastAssistantIndex = messages
                                    .map((m) => m.role)
                                    .lastIndexOf("assistant");
                                return messages.map((msg, i) => (
                                    <div
                                        key={msg.id ?? i}
                                        ref={
                                            i === lastUserIndex
                                                ? latestUserMessageRef
                                                : null
                                        }
                                    >
                                        {msg.role === "user" ? (
                                            <UserMessage
                                                content={msg.content ?? ""}
                                                files={msg.files}
                                                workflow={msg.workflow}
                                                onFileClick={(file) => {
                                                    if (!file.document_id)
                                                        return;
                                                    openDocument({
                                                        documentId:
                                                            file.document_id,
                                                        filename:
                                                            file.filename,
                                                        versionId:
                                                            file.version_id ??
                                                            null,
                                                        versionNumber:
                                                            file.version_number ??
                                                            null,
                                                    });
                                                }}
                                            />
                                        ) : (
                                            <AssistantMessage
                                                events={msg.events}
                                                isStreaming={
                                                    i === messages.length - 1 &&
                                                    isResponseLoading
                                                }
                                                isError={!!msg.error}
                                                errorMessage={
                                                    typeof msg.error ===
                                                    "string"
                                                        ? msg.error
                                                        : undefined
                                                }
                                                citations={msg.citations}
                                                citationStatus={
                                                    msg.citationStatus
                                                }
                                                activeCitation={
                                                    activeCitation
                                                }
                                                onCitationClick={(citation) =>
                                                    void openCitation(citation)
                                                }
                                                onOpenCitationSource={(
                                                    citation,
                                                ) =>
                                                    void openCitation(
                                                        citation,
                                                        {
                                                            showQuotes: false,
                                                        },
                                                    )
                                                }
                                                onCaseClick={(citation) =>
                                                    openCase(citation)
                                                }
                                                minHeight={
                                                    i === lastAssistantIndex
                                                        ? minHeight
                                                        : "0px"
                                                }
                                                onWorkflowClick={(id) => {
                                                    setWorkflowModalInitialId(
                                                        id,
                                                    );
                                                    setWorkflowModalOpen(true);
                                                }}
                                                onEditViewClick={openEditor}
                                                onOpenDocument={openDocument}
                                                onEditResolveStart={
                                                    handleEditResolveStart
                                                }
                                                onEditResolved={
                                                    handleEditResolved
                                                }
                                                onEditError={handleEditError}
                                                isDocReloading={(docId) =>
                                                    reloadingDocIds.has(docId)
                                                }
                                                isEditReloading={(editId) =>
                                                    reloadingEditIds.has(editId)
                                                }
                                                resolvedEditStatuses={
                                                    resolvedEditStatuses
                                                }
                                            />
                                        )}
                                    </div>
                                ));
                            })()}
                            <div ref={messagesEndRef} />
                        </div>
                    </div>
                </div>

                {/* Scroll to bottom button */}
                {showScrollButton && (
                    <div
                        className="absolute left-1/2 -translate-x-1/2 z-19"
                        style={{
                            bottom:
                                inputHeight +
                                CHAT_INPUT_BOTTOM_OFFSET +
                                SCROLL_BUTTON_INPUT_GAP,
                        }}
                    >
                        <button
                            onClick={scrollToBottom}
                            className={`cursor-pointer rounded-full p-2 transition-all ${LIQUID_GLASS_TRANSLUCENT_ACTION_CLASS}`}
                        >
                            <ArrowDown className="h-6 w-6 text-gray-500" />
                        </button>
                    </div>
                )}

                {/* Chat input */}
                <div className="absolute bottom-3 left-0 right-0 w-full z-30">
                    <div className="pointer-events-none absolute -bottom-3 left-0 right-0 z-0">
                        <div className="mx-auto h-7 w-full max-w-4xl px-4 md:px-6">
                            <div className="h-full rounded-t-[20px] bg-app-background" />
                        </div>
                    </div>
                    <div
                        ref={measuredInputRef}
                        className="relative z-20 w-full max-w-4xl mx-auto px-4 md:px-6"
                    >
                        <div className="w-full rounded-t-[20px] bg-transparent">
                            {activeInput ? (
                                <AskInputPopup
                                    key={activeInput.key}
                                    event={activeInput.event}
                                    onSubmit={(response, content, files) => {
                                        setHiddenAskInputKeys((prev) => {
                                            const next = new Set(prev);
                                            next.add(activeInput.key);
                                            return next;
                                        });
                                        void handleChat(
                                            { role: "user", content, files },
                                            {
                                                askInputsResponse: response,
                                            },
                                        );
                                    }}
                                    onDismiss={() => {
                                        setHiddenAskInputKeys((prev) => {
                                            const next = new Set(prev);
                                            next.add(activeInput.key);
                                            return next;
                                        });
                                        cancel();
                                    }}
                                />
                            ) : (
                                <ChatInput
                                    ref={chatInputRef}
                                    onSubmit={handleChat}
                                    onCancel={cancel}
                                    isLoading={isResponseLoading}
                                    chatKey={chatId}
                                    chatModel={chatModel}
                                    chatReasoningLevel={chatReasoningLevel}
                                    onDocumentClick={(document) =>
                                        openDocument({
                                            documentId: document.id,
                                            filename: document.filename,
                                            versionId:
                                                document.current_version_id ??
                                                null,
                                            versionNumber:
                                                document.active_version_number ??
                                                null,
                                        })
                                    }
                                />
                            )}
                        </div>
                    </div>
                </div>
            </div>

            <QuoteSelectionPopup
                selection={quotableSelection}
                onAdd={addQuotedExcerpt}
            />

            <AssistantWorkflowModal
                open={workflowModalOpen}
                onClose={() => setWorkflowModalOpen(false)}
                onSelect={() => setWorkflowModalOpen(false)}
                initialWorkflowId={workflowModalInitialId}
            />

            {panelMounted && (
                <div
                    className={`fixed inset-0 z-40 flex justify-center p-3 transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] md:relative md:inset-auto md:z-auto md:block md:h-full md:min-w-0 md:flex-shrink-0 md:p-0 ${panelVisible ? "translate-x-0" : "translate-x-full"}`}
                >
                    <AssistantSidePanel
                        tabs={tabs}
                        activeTabId={activeTabId}
                        onActivateTab={setActiveTabId}
                        onCloseTab={closeTab}
                        onCloseAll={closeAllTabs}
                        onReorderTabs={reorderTabs}
                        isEditorReloading={(documentId) =>
                            reloadingDocIds.has(documentId)
                        }
                        isEditReloading={(editId) =>
                            reloadingEditIds.has(editId)
                        }
                        onEditResolveStart={handleEditResolveStart}
                        onEditResolved={handleEditResolved}
                        onEditError={handleEditError}
                        onWarningDismiss={handleWarningDismiss}
                        onScrollChange={handleScrollChange}
                    />
                </div>
            )}
        </div>
    );
}
