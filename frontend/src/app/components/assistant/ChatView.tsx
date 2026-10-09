"use client";

import { findPendingAskInput } from "@/app/lib/pendingAskInput";
import { useCallback, useMemo, useState, useRef, useEffect } from "react";
import { createPortal, flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import {
    ArrowDown,
    PanelRight,
    Pencil,
    Plus,
    Trash2,
    Users,
    Zap,
} from "lucide-react";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { ChatInput } from "./ChatInput";
import { InitialView } from "./InitialView";
import { QuickActionsModal } from "./QuickActionsModal";
import { AddDocumentsModal } from "@/app/components/modals/AddDocumentsModal";
import { useQuickActions } from "@/app/hooks/useQuickActions";
import { resolveDocumentViewType } from "@/app/lib/documentViewType";
import type { ChatInputHandle } from "./ChatInput";
import { ChatInputPrompt } from "./ChatInputPrompt";
import {
    AssistantSidePanel,
    assistantSidePanelTabId,
    reorderAssistantSidePanelTabs,
    upsertAssistantSidePanelTab,
    type AssistantTabDropPosition,
    type AssistantSidePanelTab,
} from "./AssistantSidePanel";
import { AssistantWorkflowModal } from "./AssistantWorkflowModal";
import { ChatAccessModal } from "./ChatAccessModal";
import type {
    AssistantEvent,
    Chat,
    Citation,
    EditAnnotation,
    Document,
    PanelDocument,
    Message,
} from "../shared/types";
import {
    panelDocumentFromCaseEvent,
    panelDocumentFromCitation,
    panelDocumentType,
} from "../shared/types";
import { useSidebar } from "@/app/contexts/SidebarContext";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { usePageChrome } from "@/app/contexts/PageChromeContext";
import { invalidateDocxBytes } from "@/app/hooks/useFetchDocxBytes";
import { panelDocumentAtVersion } from "@/app/lib/panelDocumentAtVersion";
import { resolvePanelDocumentVersionResult } from "./panelDocumentVersion";
import { LIQUID_GLASS_TRANSLUCENT_ACTION_CLASS } from "@/app/components/ui/liquid-surface";
import { HeaderButtonUI, HeaderButtonsUI } from "@/shared/ui/HeaderButtonsUI";
import {
    HeaderActionsMenu,
    type HeaderActionsMenuItem,
} from "@/app/components/shared/HeaderActionsMenu";
import { PermissionDeniedPopup } from "@/app/components/popups/PermissionDeniedPopup";
import { RenameModal } from "@/app/components/modals/RenameModal";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { ApiKeyMissingPopup } from "@/app/components/popups/ApiKeyMissingPopup";
import {
    getModelProvider,
    providerLabel,
} from "@/app/lib/modelAvailability";
import { can, roleFrom } from "@/app/lib/permissions";
import {
    getDocument,
    renameProjectDocument,
    renameLibraryDocument,
    deleteDocument,
} from "@/app/lib/mikeApi";
import {
    notifyError,
    userFacingApiError,
    UserVisibleError,
} from "@/app/lib/userFacingError";

interface Props {
    chatId?: string | null;
    chat?: Chat | null;
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
    /** Stop control: aborts the turn in flight. */
    cancel: () => void;
    /**
     * Set when a provider rejected the caller's API key on the last send.
     * Surfaces the fix-your-key popup; retrying is pointless until it changes.
     * `model` may be null (an ask-inputs response carries none), which only
     * costs the provider's name in the message.
     */
    rejectedApiKey?: { model: string | null } | null;
    onDismissInvalidApiKey?: () => void;
    /**
     * Whether the caller may write in this chat. The server serves the
     * standing on GET /chat/:id; surfaces that know it must pass it, so a
     * read-only caller gets the disabled composer instead of a 403 on send.
     *
     * `null` is the third answer: not known yet. It closes the composer like
     * `false` does, but says nothing about the caller's access, so the page
     * does not accuse an owner of being a viewer for the length of a fetch.
     */
    canSend?: boolean | null;
    /**
     * Whether `canSend` is known yet. While the served standing is still in
     * flight, access is unknown — neither a licence nor a refusal — so the
     * composer is not rendered at all rather than flashing the read-only
     * placeholder at a caller who does have edit access. Surfaces that know
     * the standing at mount leave this alone.
     */
    accessResolved?: boolean;
    /**
     * Whether this chat's history is still loading. Separate from `canSend`
     * so the composer can say which of the two is closing it: once the
     * standing is resolved the composer stays on the page, and a thread switch
     * reads "still arriving" (while an answer streams into the thread) or
     * "loading", not "needs edit access".
     */
    chatLoading?: boolean;
    /** Shares document previews with the initial composer before a chat exists. */
    onInitialSubmit?: (message: Message) => void;
    /** Leaves this chat for the new-chat view, without cancelling its answer. */
    onNewChat: () => void;
}

const ASSISTANT_PANEL_TRANSITION_MS = 500;
const MOBILE_BREAKPOINT_PX = 768;
const DEFAULT_ASSISTANT_BOTTOM_PADDING = 116;
const CHAT_MESSAGE_TOP_PADDING = 76;
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
    chat,
    chatModel,
    chatReasoningLevel,
    messages,
    isResponseLoading,
    handleChat,
    cancel,
    rejectedApiKey = null,
    onDismissInvalidApiKey,
    canSend,
    accessResolved = true,
    chatLoading,
    onInitialSubmit,
    onNewChat,
}: Props) {
    const router = useRouter();
    // The model is what we asked for, so it identifies whose key was rejected.
    const rejectedKeyProvider = useMemo(
        () =>
            rejectedApiKey?.model
                ? getModelProvider(rejectedApiKey.model)
                : null,
        [rejectedApiKey],
    );
    const [deleteTarget, setDeleteTarget] = useState<PanelDocument | null>(null);
    const [deletingDocument, setDeletingDocument] = useState(false);
    const [tabs, setTabs] = useState<AssistantSidePanelTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [panelMounted, setPanelMounted] = useState(false);
    const [panelVisible, setPanelVisible] = useState(false);
    const [workflowModalOpen, setWorkflowModalOpen] = useState(false);
    const [shareOpen, setShareOpen] = useState(false);
    const [openDocumentsModalOpen, setOpenDocumentsModalOpen] = useState(false);
    const [quickActionsModalOpen, setQuickActionsModalOpen] = useState(false);
    // A new chat shows the quick actions; a started one only edits them.
    const isNewChat = !!onInitialSubmit;
    const { quickActions, saveQuickAction, addQuickAction } = useQuickActions(
        isNewChat || quickActionsModalOpen,
    );
    const [actionGate, setActionGate] = useState<{
        action: string;
        requiredRole: "owner" | "editor";
        /** Overrides the role-derived heading/body for refusals that are
         *  not about the caller's role on THIS chat — the shared-chat
         *  citation case, where the documents were simply not shared. */
        title?: string;
        message?: string;
    } | null>(null);
    const [renameOpen, setRenameOpen] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const [actionError, setActionError] = useState<{
        title: string;
        message: string;
    } | null>(null);
    const [workflowModalInitialId, setWorkflowModalInitialId] = useState<
        string | undefined
    >();
    const [reloadingDocIds, setReloadingDocIds] = useState<Set<string>>(
        () => new Set(),
    );
    // Per-edit in-flight set — disables Accept/Reject on only the one
    // edit currently being resolved, so sibling edits in the same message
    // (and their twins in DocumentContent) stay clickable.
    const [reloadingEditIds, setReloadingEditIds] = useState<Set<string>>(
        () => new Set(),
    );
    const { setSidebarOpen } = useSidebar();
    const { mobileActionsContainer } = usePageChrome();
    const {
        chats,
        renameChat,
        deleteChat,
    } = useChatHistoryContext();
    const activeChat =
        (chatId ? chats?.find((entry) => entry.id === chatId) : null) ??
        chat ??
        null;
    const activeChatRole = activeChat ? roleFrom(activeChat) : null;
    const panelCloseTimerRef = useRef<number | null>(null);
    const activeTab = tabs.find((tab) => tab.id === activeTabId);
    const activeCitation =
        activeTab?.kind === "citation" ? activeTab.citation : null;

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
            showPanel();
        },
        [showPanel],
    );

    /**
     * Say why a document behind this chat would not open.
     *
     * A chat can be shared without its documents, and that is the common case
     * for a standalone chat: the recipient's version lookup answers 403/404.
     * Silently returning made every citation pill a dead control with no hint
     * why. But 404 has a second reading, and the sharing sentence is a lie in
     * it: the chat's OWNER sees the same status when the document they cited
     * has since been deleted, and telling them somebody withheld their own
     * file explains nothing and points at nobody. Role decides which of the
     * two the reader is looking at.
     *
     * Only for a STANDALONE chat, though. In a project chat `activeChatRole`
     * is the role on the PROJECT, so every editor and viewer there was told
     * "the person who shared this chat has not shared its documents" about a
     * project document they can see perfectly well and that had simply been
     * deleted. Nobody shared that chat with them; they are in the project.
     * A project chat keeps the generic notice.
     *
     * Everything else — network, 5xx, a document with no versions at all —
     * is not about access and gets the plain failure notice rather than a
     * permission popup.
     */
    const reportUnresolvedDocument = useCallback(
        (status: "denied" | "unavailable") => {
            const sharedStandaloneChat =
                !activeChat?.project_id && activeChatRole !== "owner";
            if (status === "denied" && sharedStandaloneChat) {
                setActionGate({
                    action: "open this document",
                    requiredRole: "editor",
                    title: "Document not shared",
                    message:
                        "The person who shared this chat has not shared its documents.",
                });
                return;
            }
            notifyError(new UserVisibleError(
                status === "denied"
                    ? "This document is no longer available."
                    : "This document could not be opened. Please try again.",
                { kind: status === "denied" ? "forbidden" : "unknown", retryable: false },
            ), { action: "open this document" });
        },
        [activeChat?.project_id, activeChatRole],
    );

    /**
     * Open a tab showing a single citation quote. Called from
     * AssistantMessage when the user clicks a numbered citation pill.
     */
    const openCitation = useCallback(
        async (citation: Citation, options?: { showQuotes?: boolean }) => {
            const showQuotes = options?.showQuotes ?? true;
            const resolution = await resolvePanelDocumentVersionResult(
                panelDocumentFromCitation(citation, showQuotes),
            );
            if (resolution.status !== "resolved") {
                reportUnresolvedDocument(resolution.status);
                return;
            }
            const document = resolution.document;
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
        [reportUnresolvedDocument, upsertTab],
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
        async (ann: EditAnnotation, filename: string, changeNumber?: number) => {
            const resolution = await resolvePanelDocumentVersionResult({
                document_id: ann.document_id,
                title: filename,
                type: panelDocumentType(filename),
                metadata: [],
                quotes: [],
                version_id: ann.version_id ?? null,
                version_number: ann.version_number ?? null,
            });
            if (resolution.status !== "resolved") {
                reportUnresolvedDocument(resolution.status);
                return;
            }
            const document = resolution.document;
            upsertTab({
                kind: "edit",
                id: assistantSidePanelTabId(document),
                document,
                edit: ann,
                changeNumber,
            });
        },
        [reportUnresolvedDocument, upsertTab],
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
            fileType?: string | null;
        }) => {
            // The download card's click is the same question the citation
            // pill asks, and it was answered with a bare `return`: a card
            // whose document was deleted, or never shared, did nothing at all
            // when clicked. Same resolution, same words.
            const resolution = await resolvePanelDocumentVersionResult({
                document_id: args.documentId,
                title: args.filename,
                type: args.fileType
                    ? resolveDocumentViewType({
                          filename: args.filename,
                          fileType: args.fileType,
                      })
                    : panelDocumentType(args.filename),
                metadata: [],
                quotes: [],
                version_id: args.versionId,
                version_number: args.versionNumber,
            });
            if (resolution.status !== "resolved") {
                reportUnresolvedDocument(resolution.status);
                return;
            }
            const document = resolution.document;
            upsertTab({
                kind: "document",
                id: assistantSidePanelTabId(document),
                document,
            });
        },
        [reportUnresolvedDocument, upsertTab],
    );

    const handleAttachedDocumentClick = useCallback(
        (document: Document) => {
            void openDocument({
                documentId: document.id,
                filename: document.filename,
                versionId: document.current_version_id ?? null,
                versionNumber: document.active_version_number ?? null,
                fileType: document.file_type,
            });
        },
        [openDocument],
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

    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const messagesContentRef = useRef<HTMLDivElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const latestUserMessageRef = useRef<HTMLDivElement>(null);
    const chatInputRef = useRef<ChatInputHandle | null>(null);
    const measuredInputRef = useRef<HTMLDivElement>(null);
    // Seed "already in place" when messages exist at mount (a freshly created
    // chat arrives with its first message in hand). Otherwise the skeleton +
    // opacity-0 gate would flash the message out and fade it back in on every
    // remount. Existing chats mount with messages === [] and fetch async, so
    // they still start hidden and reveal once loaded.
    const hasScrolledRef = useRef(messages.length > 0 && !chatLoading);
    const positionedChatRef = useRef<string | undefined>(
        messages.length > 0 && !chatLoading ? chatId : undefined,
    );
    const [messagesVisible, setMessagesVisible] = useState(
        () => messages.length > 0 && !chatLoading,
    );
    const [showScrollButton, setShowScrollButton] = useState(false);
    const scrollButtonVisibleRef = useRef(false);
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
        // Re-runs when the composer mounts: it is absent until access
        // resolves, and the scroll button is positioned from its height.
    }, [accessResolved]);

    useEffect(() => {
        const container = messagesContainerRef.current;
        const userMessage = latestUserMessageRef.current;
        if (!container || !userMessage) return;
        // Size the latest response so that, scrolled to the bottom, the latest
        // user message sits CHAT_MESSAGE_TOP_PADDING below the viewport top —
        // the same place scrollLatestUserToTop puts it. Measure the real
        // scroll viewport: it is not the full dynamic viewport height.
        const update = () => {
            const messageGap =
                window.innerWidth < MOBILE_BREAKPOINT_PX ? 24 : 32;
            setMinHeight(
                `${Math.max(
                    0,
                    container.clientHeight -
                        CHAT_MESSAGE_TOP_PADDING -
                        userMessage.offsetHeight -
                        // One list gap before the response and one before
                        // the trailing scroll anchor (messagesEndRef).
                        messageGap * 2 -
                        DEFAULT_ASSISTANT_BOTTOM_PADDING,
                )}px`,
            );
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(container);
        observer.observe(userMessage);
        return () => observer.disconnect();
    }, [messages.length]);

    const isInitialView = Boolean(onInitialSubmit);
    useEffect(() => {
        const c = messagesContainerRef.current;
        const content = messagesContentRef.current;
        if (!c || !content) return;
        let frame: number | null = null;
        const measure = () => {
            frame = null;
            const height = c.scrollHeight;
            const visible =
                height > c.clientHeight &&
                height - c.scrollTop - c.clientHeight > 10;
            // Avoid dispatching even an unchanged value during a busy stream:
            // React cannot always bail out eagerly while other work is queued.
            if (visible !== scrollButtonVisibleRef.current) {
                scrollButtonVisibleRef.current = visible;
                setShowScrollButton(visible);
            }
        };
        const scheduleMeasure = () => {
            if (frame === null) frame = requestAnimationFrame(measure);
        };
        // Measure actual layout changes, including smoothed text reveal.
        // Depending on `messages` dispatches state from an effect on every
        // streamed chunk and can exceed React's nested passive-update limit.
        const observer = new ResizeObserver(scheduleMeasure);
        observer.observe(c);
        observer.observe(content);
        c.addEventListener("scroll", scheduleMeasure, { passive: true });
        scheduleMeasure();
        return () => {
            observer.disconnect();
            c.removeEventListener("scroll", scheduleMeasure);
            if (frame !== null) cancelAnimationFrame(frame);
        };
        // The container mounts when the initial screen becomes a conversation.
    }, [isInitialView]);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    const scrollLatestUserToTop = useCallback(
        (
            behavior: ScrollBehavior = "smooth",
            onPositioned?: () => void,
        ) => {
            let frame = requestAnimationFrame(() => {
                frame = requestAnimationFrame(() => {
                    const container = messagesContainerRef.current;
                    const element = latestUserMessageRef.current;
                    if (!container || !element) return;
                    // Measure both nodes in viewport coordinates. `offsetTop`
                    // can be relative to the centered inner column rather
                    // than this scrolling element, which positions a
                    // revisited thread at the wrong message.
                    const messageTop =
                        element.getBoundingClientRect().top -
                        container.getBoundingClientRect().top +
                        container.scrollTop;
                    container.scrollTo({
                        top: Math.max(
                            0,
                            messageTop - CHAT_MESSAGE_TOP_PADDING,
                        ),
                        behavior,
                    });
                    onPositioned?.();
                });
            });
            return () => cancelAnimationFrame(frame);
        },
        [],
    );

    useEffect(() => {
        if (chatLoading) return;
        const last = messages[messages.length - 1];
        if (last?.role === "user") return scrollLatestUserToTop();
    }, [chatLoading, messages, scrollLatestUserToTop]);

    useEffect(() => {
        // A detached turn attaches before its stored history arrives. Wait for
        // that history so the ref points at the latest user message in the
        // complete transcript, rather than the turn's temporary one-message
        // overlay.
        if (isResponseLoading && !chatLoading)
            return scrollLatestUserToTop();
    }, [chatLoading, isResponseLoading, scrollLatestUserToTop]);

    const hasMessages = messages.length > 0;
    const userMessageCount = messages.filter(
        (message) => message.role === "user",
    ).length;
    /* eslint-disable react-hooks/set-state-in-effect -- visibility is synchronized with completion of the selected chat's DOM positioning */
    useEffect(() => {
        const viewingUnpositionedChat = positionedChatRef.current !== chatId;
        if (chatLoading) {
            hasScrolledRef.current = false;
            // A live detached turn keeps `messages` non-empty while history
            // loads, so the chat id/loading state—not an empty transcript—is
            // what resets the positioning gate.
            setMessagesVisible(false);
            return;
        }
        if (!hasMessages) {
            hasScrolledRef.current = false;
            positionedChatRef.current = undefined;
            setMessagesVisible(false);
        } else if (!hasScrolledRef.current || viewingUnpositionedChat) {
            if (
                userMessageCount >= 2 &&
                latestUserMessageRef.current &&
                messagesContainerRef.current
            ) {
                return scrollLatestUserToTop("auto", () => {
                    hasScrolledRef.current = true;
                    positionedChatRef.current = chatId;
                    setMessagesVisible(true);
                });
            } else {
                hasScrolledRef.current = true;
                positionedChatRef.current = chatId;
                setMessagesVisible(true);
            }
        }
        // Keep the two-frame positioning operation alive while text streams.
        // Depending on messages would cancel it before its reveal callback.
    }, [
        chatId,
        chatLoading,
        hasMessages,
        userMessageCount,
        scrollLatestUserToTop,
    ]);
    /* eslint-enable react-hooks/set-state-in-effect */

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

    const handleShareChat = () => {
        if (!activeChat) return;
        if (!can(activeChatRole, "access.manage")) {
            setActionGate({
                action: "share this chat",
                requiredRole: "owner",
            });
            return;
        }
        setShareOpen(true);
    };

    const handleRenameChat = async () => {
        if (!activeChat) return;
        if (!can(activeChatRole, "content.edit")) {
            setActionGate({
                action: "rename this chat",
                requiredRole: "editor",
            });
            return;
        }
        setRenameOpen(true);
    };

    const handleRenameSave = async (title: string) => {
        if (!activeChat) return;
        setRenaming(true);
        try {
            await renameChat(activeChat.id, title);
            setRenameOpen(false);
        } catch (error) {
            setRenameOpen(false);
            notifyError(error, {
                action: "rename this chat",
                fallback: "The chat could not be renamed. Try again.",
            });
        } finally {
            setRenaming(false);
        }
    };

    const handleDeleteChat = async () => {
        if (!activeChat) return;
        if (!can(activeChatRole, "container.delete")) {
            setActionGate({
                action: "delete this chat",
                requiredRole: "owner",
            });
            return;
        }
        try {
            await deleteChat(activeChat.id);
            router.push("/assistant");
        } catch (error) {
            notifyError(error, {
                action: "delete this chat",
                fallback: "The chat could not be deleted. Try again.",
                onRetry: () => void handleDeleteChat(),
            });
        }
    };

    const chatActionItems: HeaderActionsMenuItem[] = [
        {
            label: "Share",
            icon: Users,
            onSelect: handleShareChat,
            disabled: !activeChat,
        },
        {
            label: "Rename",
            icon: Pencil,
            onSelect: () => void handleRenameChat(),
            disabled: !activeChat,
        },
        {
            label: "Delete",
            icon: Trash2,
            onSelect: () => void handleDeleteChat(),
            disabled: !activeChat,
            variant: "danger",
        },
    ];

    const renderChatHeaderActions = () => (
        <HeaderButtonsUI className="pointer-events-auto backdrop-blur-2xl">
            {!isNewChat && (
                <HeaderButtonUI
                    iconOnly
                    aria-label="New chat"
                    title="New chat"
                    onClick={onNewChat}
                >
                    <Plus className="h-4 w-4" />
                </HeaderButtonUI>
            )}
            <HeaderActionsMenu
                title="Chat actions"
                items={[
                    {
                        label: "Open side panel",
                        icon: PanelRight,
                        onSelect: showPanel,
                    },
                    {
                        label: "Edit quick actions",
                        icon: Zap,
                        onSelect: () => setQuickActionsModalOpen(true),
                    },
                    ...(isNewChat ? [] : chatActionItems),
                ]}
            />
        </HeaderButtonsUI>
    );

    const renderHeaderActionSlots = () => (
        <>
            <div
                data-slot="chat-header-actions"
                className="pointer-events-none absolute right-4 top-4.5 z-30 hidden md:block md:right-8"
            >
                {renderChatHeaderActions()}
            </div>

            {mobileActionsContainer
                ? createPortal(
                      <div className="flex min-w-0 items-center justify-end overflow-visible py-2 -my-2">
                          {renderChatHeaderActions()}
                      </div>,
                      mobileActionsContainer,
                  )
                : null}
        </>
    );

    const messagesBottomPadding = DEFAULT_ASSISTANT_BOTTOM_PADDING;
    // Readers of a shared chat may view its documents but not change them.
    const canWrite =
        accessResolved && (canSend === undefined || canSend === true);

    return (
        <div className="h-full w-full flex relative">
            {/* Chat column */}
            <div className="flex min-w-0 flex-col h-full flex-1 relative">
                {renderHeaderActionSlots()}
                {onInitialSubmit ? (
                    <InitialView
                        inputRef={chatInputRef}
                        onSubmit={onInitialSubmit}
                        onDocumentClick={handleAttachedDocumentClick}
                        quickActions={quickActions}
                        onEditQuickActions={() =>
                            setQuickActionsModalOpen(true)
                        }
                    />
                ) : (
                    <>

                        {/* Scrollable messages */}
                        <div
                            ref={messagesContainerRef}
                            className="flex-1 w-full overflow-y-auto"
                            style={{ scrollbarGutter: "stable both-edges" }}
                        >
                            <div
                                ref={messagesContentRef}
                                data-slot="chat-messages-content"
                                className="w-full max-w-4xl mx-auto px-6 md:px-8 min-h-full flex flex-col relative"
                                style={{
                                    paddingTop: CHAT_MESSAGE_TOP_PADDING,
                                    paddingBottom: messagesBottomPadding,
                                }}
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
                                        // The message still waiting on the
                                        // user's input or approval, if any.
                                        const pendingAskInputIndex =
                                            findPendingAskInput(messages)
                                                ?.messageIndex ?? -1;
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
                                                        onWorkflowClick={(wf) => {
                                                            setWorkflowModalInitialId(
                                                                wf.id,
                                                            );
                                                            setWorkflowModalOpen(true);
                                                        }}
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
                                                        awaitingInput={
                                                            i === pendingAskInputIndex
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
                                                        onCitationClick={(citation) => {
                                                            if (activeCitation === citation && activeTab) {
                                                                handleCloseAnnotation(activeTab.id);
                                                            } else {
                                                                void openCitation(citation);
                                                            }
                                                        }}
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

                        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
                            <div className="mx-auto h-28 w-full max-w-4xl px-4 md:px-6">
                                <div className="assistant-chat-input-fade h-full w-full" />
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
                                    type="button"
                                    aria-label="Scroll to bottom"
                                    onClick={scrollToBottom}
                                    className={`cursor-pointer rounded-full p-2 transition-all ${LIQUID_GLASS_TRANSLUCENT_ACTION_CLASS}`}
                                >
                                    <ArrowDown className="h-6 w-6 text-gray-500" />
                                </button>
                            </div>
                        )}

                        {/* Chat input */}
                        {accessResolved && (
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
                                        <ChatInputPrompt
                                            messages={messages}
                                            chatKey={chatId}
                                            canSend={canSend}
                                            chatLoading={chatLoading}
                                            onSubmit={(response, content, files) =>
                                                handleChat(
                                                    { role: "user", content, files },
                                                    { askInputsResponse: response },
                                                )
                                            }
                                            onCancel={cancel}
                                        >
                                            <ChatInput
                                                ref={chatInputRef}
                                                canSend={canSend}
                                                chatLoading={chatLoading}
                                                onSubmit={handleChat}
                                                onCancel={cancel}
                                                isLoading={isResponseLoading}
                                                chatKey={chatId}
                                                chatModel={chatModel}
                                                chatReasoningLevel={chatReasoningLevel}
                                                onDocumentClick={
                                                    handleAttachedDocumentClick
                                                }
                                            />
                                        </ChatInputPrompt>
                                    </div>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>

            <AssistantWorkflowModal
                open={workflowModalOpen}
                onClose={() => setWorkflowModalOpen(false)}
                onSelect={() => setWorkflowModalOpen(false)}
                initialWorkflowId={workflowModalInitialId}
            />

            {shareOpen && activeChat ? (
                <ChatAccessModal
                    open={shareOpen}
                    chat={activeChat}
                    onClose={() => setShareOpen(false)}
                />
            ) : null}

            {/* TODO(contacts): GET /chat/:id (backend/src/routes/chat.ts)
                serves chat + is_owner + access_role and no ranked contact
                list, so there is nothing to thread into `contacts` here and
                the "Ask …" line cannot render on chat surfaces. Needs a
                server change (the shape project detail already returns as
                `admin_contacts`) before this popup can name anybody. */}
            <PermissionDeniedPopup
                open={!!actionGate}
                action={actionGate?.action}
                requiredRole={actionGate?.requiredRole}
                title={actionGate?.title}
                message={actionGate?.message}
                onClose={() => setActionGate(null)}
            />

            <ApiKeyMissingPopup
                open={rejectedApiKey !== null}
                title="API key rejected"
                message={`${
                    rejectedKeyProvider
                        ? `The ${providerLabel(rejectedKeyProvider)} API key`
                        : "That API key"
                } was rejected. If it is your own key, check it in Settings; otherwise contact your administrator.`}
                onClose={() => onDismissInvalidApiKey?.()}
            />
            <RenameModal
                open={renameOpen}
                breadcrumbs={["Assistant", "Rename Chat"]}
                label="Chat title"
                initialValue={activeChat?.title?.trim() || "Untitled chat"}
                saving={renaming}
                onClose={() => {
                    if (!renaming) setRenameOpen(false);
                }}
                onSave={(title) => void handleRenameSave(title)}
            />
            <WarningPopup
                open={!!actionError}
                title={actionError?.title ?? "Chat action failed"}
                message={actionError?.message ?? null}
                onClose={() => setActionError(null)}
            />

            <ConfirmPopup
                open={!!deleteTarget}
                title="Delete file?"
                message={`Delete “${deleteTarget?.title ?? "this file"}” and its versions? This cannot be undone.`}
                confirmLabel="Delete file"
                confirmVariant="danger"
                confirmStatus={deletingDocument ? "loading" : "idle"}
                onCancel={() => { if (!deletingDocument) setDeleteTarget(null); }}
                onConfirm={() => {
                    if (!deleteTarget || deletingDocument || !canWrite) return;
                    const target = deleteTarget;
                    setDeletingDocument(true);
                    void (async () => {
                        try {
                            const file = await getDocument(target.document_id);
                            if (file.can_delete !== true) {
                                setActionError({ title: "Delete failed", message: "You do not have permission to delete this file." });
                                return;
                            }
                            await deleteDocument(target.document_id);
                            setTabs((current) => {
                                const remaining = current.filter((tab) => tab.document.document_id !== target.document_id);
                                setActiveTabId((id) => remaining.some((tab) => tab.id === id) ? id : remaining[0]?.id ?? null);
                                return remaining;
                            });
                            setDeleteTarget(null);
                        } catch (cause) {
                            setActionError({ title: "Delete failed", message: userFacingApiError(cause, "This file could not be deleted. Please try again.") });
                        } finally { setDeletingDocument(false); }
                    })();
                }}
            />

            {panelMounted && (
                <div
                    className={`fixed inset-0 z-40 flex justify-center p-3 transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] md:relative md:inset-auto md:z-auto md:block md:h-full md:min-w-0 md:flex-shrink-0 md:p-0 ${panelVisible ? "translate-x-0" : "translate-x-full"}`}
                >
                    <AssistantSidePanel
                        tabs={tabs}
                        canEdit={canWrite}
                        documentActions={(document) => ({
                            addToChatDisabled: !canWrite || !!chatLoading,
                            onAddToChat: async () => {
                                const file = await getDocument(
                                    document.document_id,
                                );
                                chatInputRef.current?.addDoc(file);
                            },
                            onRename: async (filename) => {
                                const file = await getDocument(
                                    document.document_id,
                                );
                                const updated = file.project_id
                                    ? await renameProjectDocument(
                                          file.project_id,
                                          file.id,
                                          filename,
                                      )
                                    : await renameLibraryDocument(
                                          file.library_kind === "template"
                                              ? "templates"
                                              : "files",
                                          file.id,
                                          filename,
                                      );
                                setTabs((current) =>
                                    current.map((tab) =>
                                        tab.document.document_id === file.id
                                            ? {
                                                  ...tab,
                                                  document: {
                                                      ...tab.document,
                                                      title: updated.filename,
                                                  },
                                              }
                                            : tab,
                                    ),
                                );
                            },
                            onDelete: canWrite ? () => setDeleteTarget(document) : undefined,
                        })}
                        activeTabId={activeTabId}
                        onActivateTab={setActiveTabId}
                        onCloseTab={closeTab}
                        onCloseAll={closeAllTabs}
                        onVersionChange={(tabId, version) => setTabs((current) => current.map((tab) =>
                            tab.id === tabId ? { id: tab.id, kind: "document", document: panelDocumentAtVersion(tab.document, version) } : tab))}
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
                        onCloseAnnotation={handleCloseAnnotation}
                        onScrollChange={handleScrollChange}
                        onOpenDocuments={() => setOpenDocumentsModalOpen(true)}
                    />
                </div>
            )}

            <AddDocumentsModal
                open={openDocumentsModalOpen}
                onClose={() => setOpenDocumentsModalOpen(false)}
                onSelect={(documents) => {
                    setOpenDocumentsModalOpen(false);
                    documents.forEach(handleAttachedDocumentClick);
                }}
                breadcrumb={["Assistant", "Open Documents"]}
                uploadStateId="assistant-side-panel"
            />
            <QuickActionsModal
                open={quickActionsModalOpen}
                onClose={() => setQuickActionsModalOpen(false)}
                actions={quickActions}
                onSave={saveQuickAction}
                onCreate={addQuickAction}
            />
        </div>
    );
}
