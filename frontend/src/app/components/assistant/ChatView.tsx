"use client";

import { findPendingAskInput } from "@/app/lib/pendingAskInput";
import {
    useCallback,
    useMemo,
    useState,
    useRef,
    useEffect,
    type CSSProperties,
    type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import {
    ArrowDown,
    Columns2,
    History,
    PanelRight,
    Pencil,
    Plus,
    Trash2,
    Users,
    X,
    Zap,
} from "lucide-react";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { ChatInput } from "./ChatInput";
import { InitialView } from "./InitialView";
import { QuickActionsModal } from "./QuickActionsModal";
import { useQuickActions } from "@/app/hooks/useQuickActions";
import { resolveDocumentViewType } from "@/app/lib/documentViewType";
import type { ChatInputHandle } from "./ChatInput";
import { ChatInputPrompt } from "./ChatInputPrompt";
import { ResponseSelectionMenuUI } from "@/shared/ui/ResponseSelectionMenuUI";
import type { MessageExcerpt } from "@/shared/lib/messageExcerpts";
import { assistantSidePanelTabId } from "./AssistantSidePanel";
import { AssistantDocumentPanelHost } from "./AssistantDocumentPanelHost";
import {
    useAssistantDocumentPanel,
    type AssistantDocumentPanel,
} from "./useAssistantDocumentPanel";
import { AssistantWorkflowModal } from "./AssistantWorkflowModal";
import { ChatAccessModal } from "./ChatAccessModal";
import type {
    AssistantEvent,
    Chat,
    Citation,
    EditAnnotation,
    Document,
    Message,
} from "../shared/types";
import {
    panelDocumentFromCaseEvent,
    panelDocumentFromCitation,
    panelDocumentType,
} from "../shared/types";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { usePageChrome } from "@/app/contexts/PageChromeContext";
import { resolvePanelDocumentVersionResult } from "./panelDocumentVersion";
import { LIQUID_GLASS_TRANSLUCENT_ACTION_CLASS } from "@/app/components/ui/liquid-surface";
import {
    HeaderButtonUI,
    HeaderButtonsUI,
    headerButtonClassName,
} from "@/shared/ui/HeaderButtonsUI";
import {
    HeaderActionsMenu,
    type HeaderActionsMenuItem,
} from "@/app/components/shared/HeaderActionsMenu";
import { PermissionDeniedPopup } from "@/app/components/popups/PermissionDeniedPopup";
import { RenameModal } from "@/app/components/modals/RenameModal";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { ApiKeyMissingPopup } from "@/app/components/popups/ApiKeyMissingPopup";
import {
    getModelProvider,
    providerLabel,
} from "@/app/lib/modelAvailability";
import { can, roleFrom } from "@/app/lib/permissions";
import { AssistantChatHistoryMenu } from "./AssistantChatHistoryMenu";
import { cn } from "@/app/lib/utils";
import { userFacingApiError } from "@/app/lib/userFacingError";

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
    /** After this chat is deleted. Defaults to the assistant's new-chat page. */
    onChatDeleted?: () => void;
}

interface ColumnProps extends Props {
    /** The side panel this chat opens its documents in. */
    documentPanel: AssistantDocumentPanel;
    /** Identifies this chat to the panel when two share the page. */
    paneId?: string;
    /** Offers "Open side chat" in the chat actions. */
    onOpenSideChat?: () => void;
    /**
     * Shows another chat in this column. Offers the chat history: as a header
     * button on a new chat, and as "Load chat" in the chat actions.
     */
    onLoadChat?: (chatId: string) => void;
    /** The chat in the other column, which the history list leaves out. */
    hiddenChatId?: string | null;
    /** Makes this the side chat, and offers closing it. */
    onCloseSideChat?: () => void;
    /** This column's share of the width when two chats split the page. */
    widthShare?: number;
    /** Quotes a passage of this chat in the chat beside it. */
    onAskInSideChat?: (excerpt: MessageExcerpt) => void;
    /** A passage quoted from the chat beside this one, for the composer. */
    incomingExcerpt?: { id: number; excerpt: MessageExcerpt } | null;
    onIncomingExcerptAdded?: () => void;
}

const MOBILE_BREAKPOINT_PX = 768;
const DEFAULT_ASSISTANT_BOTTOM_PADDING = 116;
const CHAT_MESSAGE_TOP_PADDING = 76;
const SCROLL_BUTTON_INPUT_GAP = 16;
const CHAT_INPUT_BOTTOM_OFFSET = 12;

/**
 * The assistant page for one chat: the conversation with its document side
 * panel. A page showing two chats composes `AssistantChatColumn` itself.
 */
export function ChatView(props: Props) {
    const documentPanel = useAssistantDocumentPanel();
    return (
        <div className="h-full w-full flex relative">
            <AssistantChatColumn {...props} documentPanel={documentPanel} />
            <AssistantDocumentPanelHost panel={documentPanel} />
        </div>
    );
}

/** One chat's conversation, composer and header actions. */
export function AssistantChatColumn({
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
    onChatDeleted,
    documentPanel,
    paneId = "primary",
    onOpenSideChat,
    onLoadChat,
    hiddenChatId,
    onCloseSideChat,
    widthShare,
    onAskInSideChat,
    incomingExcerpt,
    onIncomingExcerptAdded,
}: ColumnProps) {
    const router = useRouter();
    const {
        tabs,
        activeTabId,
        upsertTab,
        show: showPanel,
        reloadingDocIds,
        reloadingEditIds,
        resolvedEditStatuses,
        handleEditResolveStart,
        handleEditResolved,
        handleEditError,
        handleCloseAnnotation,
        registerPane,
        setActivePane,
    } = documentPanel;
    const columnRef = useRef<HTMLDivElement>(null);
    const isSideChat = !!onCloseSideChat;
    // The header actions render twice (in the column, and in the page chrome
    // on a small screen); the history menu opens on the one that asked.
    const [historyOpenIn, setHistoryOpenIn] = useState<
        "desktop" | "mobile" | null
    >(null);
    const loadChatRequestedRef = useRef<"desktop" | "mobile" | null>(null);
    const actionsAnchorRefs = useRef<
        Partial<Record<"desktop" | "mobile", HTMLSpanElement | null>>
    >({});
    // The model is what we asked for, so it identifies whose key was rejected.
    const rejectedKeyProvider = useMemo(
        () =>
            rejectedApiKey?.model
                ? getModelProvider(rejectedApiKey.model)
                : null,
        [rejectedApiKey],
    );
    const [workflowModalOpen, setWorkflowModalOpen] = useState(false);
    const [shareOpen, setShareOpen] = useState(false);
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
    const activeTab = tabs.find((tab) => tab.id === activeTabId);
    const activeCitation =
        activeTab?.kind === "citation" ? activeTab.citation : null;

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
            setActionError({
                title: "Document unavailable",
                message:
                    status === "denied"
                        ? "This document is no longer available."
                        : "This document could not be opened. Please try again.",
            });
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
            setActionError({
                title: "Chat not renamed",
                message: userFacingApiError(
                    error,
                    "The chat could not be renamed. Please try again.",
                ),
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
            if (onChatDeleted) onChatDeleted();
            else router.push("/assistant");
        } catch (error) {
            setActionError({
                title: "Chat not deleted",
                message: userFacingApiError(
                    error,
                    "The chat could not be deleted. Please try again.",
                ),
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

    const renderChatHeaderActions = (mobile = false) => {
        const slot = mobile ? "mobile" : "desktop";
        const historyMenu = (
            trigger: ReactElement,
            onCloseAutoFocus?: (event: Event) => void,
        ) =>
            onLoadChat ? (
                <AssistantChatHistoryMenu
                    open={historyOpenIn === slot}
                    onOpenChange={(open) => setHistoryOpenIn(open ? slot : null)}
                    trigger={trigger}
                    currentChatId={chatId ?? ""}
                    hiddenChatId={hiddenChatId}
                    onLoad={onLoadChat}
                    onCloseAutoFocus={onCloseAutoFocus}
                />
            ) : null;
        return (
            <HeaderButtonsUI className="pointer-events-auto backdrop-blur-2xl">
                {isNewChat ? (
                    // Nothing to leave yet, so the slot offers past chats.
                    historyMenu(
                        <button
                            type="button"
                            aria-label="Chat history"
                            title="Chat history"
                            className={headerButtonClassName({
                                iconOnly: true,
                            })}
                        >
                            <History className="h-4 w-4" />
                        </button>,
                    )
                ) : (
                    <HeaderButtonUI
                        iconOnly
                        aria-label="New chat"
                        title="New chat"
                        onClick={onNewChat}
                    >
                        <Plus className="h-4 w-4" />
                    </HeaderButtonUI>
                )}
                {/* "Load chat" swaps the actions for the chat history, which
                    opens from the same button: an anchor laid over it. */}
                <span
                    ref={(element) => {
                        actionsAnchorRefs.current[slot] = element;
                    }}
                    className="relative inline-flex"
                >
                <HeaderActionsMenu
                    title="Chat actions"
                    onCloseAutoFocus={(event) => {
                        if (loadChatRequestedRef.current !== slot) return;
                        // The history opens once this menu has closed, and
                        // takes the focus this would hand back.
                        loadChatRequestedRef.current = null;
                        event.preventDefault();
                        setHistoryOpenIn(slot);
                    }}
                    items={[
                        ...(onLoadChat && !isNewChat
                            ? [
                                  {
                                      label: "Load chat",
                                      icon: History,
                                      onSelect: () => {
                                          loadChatRequestedRef.current = slot;
                                      },
                                  },
                              ]
                            : []),
                        {
                            label: "Open side panel",
                            icon: PanelRight,
                            onSelect: showPanel,
                        },
                        // Two chats need a wide page.
                        ...(onOpenSideChat && !mobile
                            ? [
                                  {
                                      label: "Open side chat",
                                      icon: Columns2,
                                      onSelect: onOpenSideChat,
                                  },
                              ]
                            : []),
                        ...(onCloseSideChat
                            ? [
                                  {
                                      label: "Close side chat",
                                      icon: X,
                                      onSelect: onCloseSideChat,
                                  },
                              ]
                            : []),
                        {
                            label: "Edit quick actions",
                            icon: Zap,
                            onSelect: () => setQuickActionsModalOpen(true),
                        },
                        ...(isNewChat ? [] : chatActionItems),
                    ]}
                />
                {!isNewChat &&
                    historyMenu(
                        <span
                            aria-hidden="true"
                            tabIndex={-1}
                            className="pointer-events-none absolute inset-0"
                        />,
                        (event) => {
                            // Back to the button the reader actually used.
                            event.preventDefault();
                            actionsAnchorRefs.current[slot]
                                ?.querySelector("button")
                                ?.focus();
                        },
                    )}
                </span>
            </HeaderButtonsUI>
        );
    };

    const renderHeaderActionSlots = () => (
        <>
            <div
                data-slot="chat-header-actions"
                className="pointer-events-none absolute right-4 top-4.5 z-30 hidden md:block md:right-8"
            >
                {renderChatHeaderActions()}
            </div>

            {/* The side chat is not shown on a small screen. */}
            {mobileActionsContainer && !isSideChat
                ? createPortal(
                      <div className="flex min-w-0 items-center justify-end overflow-visible py-2 -my-2">
                          {renderChatHeaderActions(true)}
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

    // The composer mounts once access resolves; the passage waits for it.
    const addedExcerptIdRef = useRef<number | null>(null);
    useEffect(() => {
        const input = chatInputRef.current;
        if (!incomingExcerpt || !input || !canWrite) return;
        if (addedExcerptIdRef.current === incomingExcerpt.id) return;
        addedExcerptIdRef.current = incomingExcerpt.id;
        input.addExcerpt(incomingExcerpt.excerpt);
        onIncomingExcerptAdded?.();
    }, [incomingExcerpt, canWrite, chatLoading, onIncomingExcerptAdded]);

    // The panel keeps what it is handed, so hand it a stable way to reach
    // the latest handler: registering on every new handler would re-render
    // the panel, and with it this column, without end.
    const openAttachedDocumentRef = useRef(handleAttachedDocumentClick);
    useEffect(() => {
        openAttachedDocumentRef.current = handleAttachedDocumentClick;
    }, [handleAttachedDocumentClick]);
    useEffect(
        () =>
            registerPane(paneId, {
                canWrite,
                chatLoading: !!chatLoading,
                addDocument: (document) =>
                    chatInputRef.current?.addDoc(document),
                openDocument: (document) =>
                    openAttachedDocumentRef.current(document),
            }),
        [registerPane, paneId, canWrite, chatLoading],
    );

    return (
        <>
            {/* Chat column */}
            <div
                ref={columnRef}
                data-chat-pane={paneId}
                onPointerDownCapture={() => setActivePane(paneId)}
                onFocusCapture={() => setActivePane(paneId)}
                className={cn(
                    "min-w-0 flex-col h-full flex-1 relative",
                    // The split applies only where both chats show; alone on
                    // a small screen the primary chat takes the full width.
                    widthShare !== undefined &&
                        "md:[flex-grow:var(--chat-width-share)]",
                    // A second chat needs the room; small screens keep one.
                    isSideChat ? "hidden md:flex" : "flex",
                    // Beside another chat, nothing may spill over the line.
                    widthShare !== undefined && "overflow-x-clip",
                )}
                style={
                    widthShare === undefined
                        ? undefined
                        : ({
                              "--chat-width-share": widthShare,
                          } as CSSProperties)
                }
            >
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

            <ResponseSelectionMenuUI
                canAsk={canSend === undefined || canSend === true}
                scopeRef={columnRef}
                onAskInSideChat={onAskInSideChat}
                onAddExcerpt={(excerpt) =>
                    chatInputRef.current?.addExcerpt(excerpt)
                }
            />

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

            <QuickActionsModal
                open={quickActionsModalOpen}
                onClose={() => setQuickActionsModalOpen(false)}
                actions={quickActions}
                onSave={saveQuickAction}
                onCreate={addQuickAction}
            />
        </>
    );
}
