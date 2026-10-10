"use client";

import {
    useCallback,
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ComponentProps,
    type Dispatch,
    type Ref,
    type SetStateAction,
} from "react";
import { useRouter } from "next/navigation";
import { Brain, Columns2, Pencil, Trash2 } from "lucide-react";
import { findPendingAskInput } from "@/app/lib/pendingAskInput";
import { deleteChat } from "@/app/lib/mikeApi";
import { loadAssistantChat } from "@/app/lib/assistantTurns";
import {
    sortChatsByActivity,
    touchChatActivity,
} from "@/app/lib/chatActivity";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { useAssistantMessageLayout } from "@/app/hooks/useAssistantMessageLayout";
import {
    isChatAttachmentDrag,
    isExternalFileDrag,
} from "@/app/lib/projectDragTypes";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { UserMessage } from "@/app/components/assistant/UserMessage";
import { AssistantMessage } from "@/app/components/assistant/AssistantMessage";
import {
    ChatInput,
    type ChatInputHandle,
} from "@/app/components/assistant/ChatInput";
import { ChatInputPrompt } from "@/app/components/assistant/ChatInputPrompt";
import { ResponseSelectionMenuUI } from "@/shared/ui/ResponseSelectionMenuUI";
import { ChatPanelHeader } from "@/app/components/shared/ChatPanelHeader";
import { HeaderActionsMenu } from "@/app/components/shared/HeaderActionsMenu";
import { ApiKeyMissingPopup } from "@/app/components/popups/ApiKeyMissingPopup";
import {
    getModelProvider,
    providerLabel,
} from "@/app/lib/modelAvailability";
import { MikeIcon } from "@/shared/ui/MikeIconUI";
import type {
    Chat,
    Citation,
    Document,
    Message,
    Project,
} from "@/app/components/shared/types";
import { can, roleFromLoaded } from "@/app/lib/permissions";
import { LIQUID_GLASS_FLAT_CLASS } from "@/app/components/ui/liquid-surface";
import { cn } from "@/app/lib/utils";
import { userFacingApiError } from "@/app/lib/userFacingError";
import type { MessageExcerpt } from "@/shared/lib/messageExcerpts";

const ICON_SIZE = 28;
const GAP = 14;
const DEFAULT_ASSISTANT_BOTTOM_PADDING = 116;
const ASSISTANT_HEADER_HEIGHT = 48;

function AssistantGreeting({ username }: { username: string }) {
    const { profile } = useUserProfile();
    const [loaded, setLoaded] = useState(false);
    const [iconOffset, setIconOffset] = useState(0);
    const [textOffset, setTextOffset] = useState(0);
    const textRef = useRef<HTMLHeadingElement>(null);

    useLayoutEffect(() => {
        if (!profile || !textRef.current) return;
        const h1Width = textRef.current.offsetWidth;
        setIconOffset((h1Width + GAP) / 2);
        setTextOffset((ICON_SIZE + GAP) / 2);
    }, [profile]);

    useEffect(() => {
        if (!iconOffset) return;
        const t = setTimeout(() => setLoaded(true), 100);
        return () => clearTimeout(t);
    }, [iconOffset]);

    return (
        <div className="flex-1 flex items-center justify-center">
            <div className="relative flex items-center justify-center h-[28px]">
                <div
                    className="absolute h-[30px]"
                    style={{
                        left: "50%",
                        transform: loaded
                            ? `translateX(calc(-50% - ${iconOffset}px))`
                            : "translateX(-50%)",
                        transition:
                            "transform 900ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
                    }}
                >
                    <MikeIcon size={ICON_SIZE} />
                </div>
                <h1
                    ref={textRef}
                    className="absolute text-3xl font-serif font-light text-gray-900 whitespace-nowrap"
                    style={{
                        left: "50%",
                        transform: loaded
                            ? `translateX(calc(-50% + ${textOffset}px))`
                            : "translateX(-50%)",
                        opacity: loaded ? 1 : 0,
                        transition:
                            "transform 900ms cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 800ms ease-in-out 300ms",
                    }}
                >
                    Hi, {username}
                </h1>
            </div>
        </div>
    );
}

type AssistantMessageProps = ComponentProps<typeof AssistantMessage>;

/** What the workspace can ask of a chat panel from outside it. */
export interface ProjectChatPanelHandle {
    /** Attaches a project document to this chat's composer. */
    addDoc: (document: Document) => void;
}

interface Props {
    ref?: Ref<ProjectChatPanelHandle>;
    projectId: string;
    project: Project | null;
    projectLoaded: boolean;
    /** The chat to show, or `""` for a new one. */
    chatId: string;
    /** Shows another chat in this panel without remounting it. */
    openChat: (chatId: string) => void;
    /** Opens the chat the first answer created, keeping it on screen. */
    adoptChat: (chatId: string) => void;
    claimCreated: (chatId: string) => boolean;
    /**
     * The chat beside the primary one. It is not the chat the sidebar
     * highlights, takes no workflow hand-off, and falls back to a new chat in
     * place rather than leaving the workspace.
     */
    isSideChat?: boolean;
    width: number;
    /** Corner rounding, which depends on where the panel sits in the row. */
    roundedClassName: string;
    /** The project's chats, most recently active first. */
    chats: Chat[];
    chatsLoading: boolean;
    setProjectChats: Dispatch<SetStateAction<Chat[] | null>>;
    responseStatuses: Record<string, "loading" | "complete">;
    onClearResponseStatus: (chatId: string) => void;
    /** The chat in the other panel, which this one cannot also open. */
    hiddenChatId?: string | null;
    /** The document on screen, sent along as context for a message. */
    displayedDoc: { filename: string; documentId: string } | null;
    activeCitation: Citation | null;
    /** Edit ids being accepted or rejected, by the document they change. */
    resolvingEdits: Record<string, string>;
    resolvedEditStatuses: Record<string, "accepted" | "rejected">;
    onDocClick: (document: Document) => void;
    onCitationClick: (
        citation: Citation,
        showQuotes?: boolean,
    ) => void | Promise<void>;
    onCaseClick: NonNullable<AssistantMessageProps["onCaseClick"]>;
    onOpenDocument: NonNullable<AssistantMessageProps["onOpenDocument"]>;
    onEditViewClick: NonNullable<AssistantMessageProps["onEditViewClick"]>;
    onEditResolveStart: NonNullable<
        AssistantMessageProps["onEditResolveStart"]
    >;
    onEditResolved: NonNullable<AssistantMessageProps["onEditResolved"]>;
    onEditError: NonNullable<AssistantMessageProps["onEditError"]>;
    /** The assistant created, copied or edited a project document. */
    onProjectMutated: () => void;
    onOpenMemory: () => void;
    /** The caller lacks the role for `action`; the workspace says so. */
    onEditorGate: (action: string) => void;
    onOwnerGate: (action: string) => void;
    onActionError: (error: { title: string; message: string }) => void;
    /** The reader used this panel: it is the one "Add to chat" targets. */
    onActivate: () => void;
    /** Offers opening a second chat beside this one. */
    onOpenSideChat?: () => void;
    /** Offers closing this panel. */
    onClose?: () => void;
    /** Quotes a passage of this chat in the chat beside it. */
    onAskInSideChat?: (excerpt: MessageExcerpt) => void;
    /** A passage quoted from the chat beside this one, for the composer. */
    incomingExcerpt?: { id: number; excerpt: MessageExcerpt } | null;
    onIncomingExcerptAdded?: () => void;
}

/** One of the IDE's chat panels: its thread, header, and composer. */
export function ProjectChatPanel({
    ref,
    projectId,
    project,
    projectLoaded,
    chatId: activeChatId,
    openChat,
    adoptChat,
    claimCreated,
    isSideChat = false,
    width,
    roundedClassName,
    chats,
    chatsLoading,
    setProjectChats,
    responseStatuses,
    onClearResponseStatus,
    hiddenChatId,
    displayedDoc,
    activeCitation,
    resolvingEdits,
    resolvedEditStatuses,
    onDocClick,
    onCitationClick,
    onCaseClick,
    onOpenDocument,
    onEditViewClick,
    onEditResolveStart,
    onEditResolved,
    onEditError,
    onProjectMutated,
    onOpenMemory,
    onEditorGate,
    onOwnerGate,
    onActionError,
    onActivate,
    onOpenSideChat,
    onClose,
    onAskInSideChat,
    incomingExcerpt,
    onIncomingExcerptAdded,
}: Props) {
    const router = useRouter();
    const { user, authLoading } = useAuth();
    const { profile } = useUserProfile();
    const username =
        profile?.displayName?.trim() || user?.email?.split("@")[0] || "there";

    const activeChatIdRef = useRef(activeChatId);
    useLayoutEffect(() => {
        activeChatIdRef.current = activeChatId;
    }, [activeChatId]);
    const [chatTitle, setChatTitle] = useState<string | null>(null);
    const [chatTitleEdit, setChatTitleEdit] = useState<{
        chatId: string;
        title: string;
    } | null>(null);
    const editingChatTitle =
        chatTitleEdit?.chatId === activeChatId ? chatTitleEdit : null;
    const [chatLoaded, setChatLoaded] = useState(false);
    const [deletingChat, setDeletingChat] = useState(false);
    const [composerResetKey, setComposerResetKey] = useState(0);
    const [chatDragOver, setChatDragOver] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);
    const chatInputRef = useRef<ChatInputHandle | null>(null);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const latestUserMessageRef = useRef<HTMLDivElement>(null);
    useImperativeHandle(
        ref,
        () => ({ addDoc: (document) => chatInputRef.current?.addDoc(document) }),
        [],
    );

    const {
        setCurrentChatId,
        newChatMessages,
        setNewChatMessages,
        renameChat: renameChatInHistory,
    } = useChatHistoryContext();
    // A workflow hands its first message to the primary chat only.
    const [initialMessages] = useState<Message[]>(
        isSideChat ? [] : (newChatMessages ?? []),
    );
    const [chatModel, setChatModel] = useState<string | null | undefined>(
        initialMessages.length > 0
            ? (initialMessages[0]?.model ?? null)
            : undefined,
    );
    const [chatReasoningLevel, setChatReasoningLevel] = useState<
        NonNullable<Message["reasoning"]> | null | undefined
    >(
        initialMessages.length > 0
            ? (initialMessages[0]?.reasoning ?? null)
            : undefined,
    );
    const {
        messages,
        rejectedApiKey,
        dismissInvalidApiKey,
        isResponseLoading,
        handleChat,
        setMessages,
        cancel,
        detach,
        resetChat,
    } = useAssistantChat({
        initialMessages,
        onChatCreated: adoptChat,
        chatId: activeChatId || undefined,
        projectId,
        tracksCurrentChat: !isSideChat,
    });
    // The model is what we asked for, so it identifies whose key was rejected.
    const rejectedKeyProvider = rejectedApiKey?.model
        ? getModelProvider(rejectedApiKey.model)
        : null;

    // Server ladder: writing to a project chat needs content.edit on the
    // project.
    //
    // While the project, chat owner, or session is loading, access is unknown,
    // and unknown is neither a licence nor a refusal. Treating it as a licence
    // left a viewer typing into a live composer for the whole load window;
    // treating it as a refusal flashed the read-only placeholder at people who
    // do have edit access. So the composer is not rendered at all until all
    // three inputs resolve — the message shimmer stands in for the whole
    // surface, and what appears afterwards is already correct.
    const projectRole = roleFromLoaded(project);
    const canEditContent = can(projectRole, "content.edit");
    // There is no creator exception on a PROJECT chat. The server derives the
    // caller's whole standing here from the project role
    // (ensureSharedRowAccess): content.edit to write or rename, and
    // container.delete to delete. Adding "…or I started this thread" to the
    // client made all three gates disagree with the server in both
    // directions — an editor who created the chat was offered a Delete that
    // came back 403, and a viewer demoted after starting a thread kept a live
    // composer on it. The ladder is the only answer this panel asks for.
    //
    // Three answers, not two — the same tri-state the standalone chat page
    // adopted. `can(null, …)` is false, and false here is a SENTENCE: the
    // composer reads "Viewing only — sending needs edit access". A project
    // owner opening their own chat cold saw that accusation for the length of
    // GET /projects/:id. `null` keeps the composer closed while we wait
    // without asserting anything about who the reader is.
    const canSendChat = projectRole === null ? null : canEditContent;
    const canDeleteChat = can(projectRole, "container.delete");
    const composerReady = chatLoaded && projectLoaded && !authLoading;
    // Rename and Delete are offered by the header menu, whose handlers return
    // in silence while the role is unknown — deliberately, since accusing
    // somebody before the payload lands is a guess, but a menu item that
    // quietly does nothing when clicked is indistinguishable from a broken
    // one. Disable them for that window, the way the upload button already
    // does with `!canEditContent`.
    const roleKnown = projectRole !== null;
    const pendingInitialUserMessageRef = useRef<Message | null>(
        initialMessages.length === 1 && initialMessages[0].role === "user"
            ? initialMessages[0]
            : null,
    );

    const hasAutoSent = useRef(false);
    const hasInitialScrolled = useRef(false);
    const { minHeight, scrollLatestUserToTop } = useAssistantMessageLayout({
        containerRef: messagesContainerRef,
        userMessageRef: latestUserMessageRef,
        ready: chatLoaded,
        messageCount: messages.length,
        chatKey: activeChatId,
        bottomPadding: DEFAULT_ASSISTANT_BOTTOM_PADDING,
        headerHeight: ASSISTANT_HEADER_HEIGHT,
    });

    useEffect(() => {
        setChatTitleEdit(null);
    }, [activeChatId]);

    // Whenever the assistant mutates project documents — creating a new
    // doc, creating a new version via edit_document, or replicating a doc —
    // tell the workspace so the explorer picks up the new/changed files
    // without a manual reload. Keyed by completed mutation events only, so
    // it refetches once the backend has finished persisting the change.
    const projectMutationSignature = useMemo(() => {
        const created: string[] = [];
        const replicated: string[] = [];
        const edited = new Set<string>();
        for (const msg of messages) {
            for (const ev of msg.events ?? []) {
                if ("isStreaming" in ev && ev.isStreaming) continue;
                if (ev.type === "doc_created" && ev.document_id) {
                    created.push(
                        `${ev.document_id}:${ev.version_id ?? ""}:${ev.filename}`,
                    );
                    continue;
                }
                if (ev.type === "doc_replicated") {
                    for (const c of ev.copies ?? []) {
                        replicated.push(
                            `${c.document_id}:${c.version_id}:${c.new_filename}`,
                        );
                    }
                    continue;
                }
                if (ev.type === "doc_edited") {
                    edited.add(
                        `${ev.document_id}:${ev.version_id ?? ""}:${ev.version_number ?? ""}`,
                    );
                }
            }
        }
        return [
            `created=${created.sort().join(",")}`,
            `replicated=${replicated.sort().join(",")}`,
            `edited=${Array.from(edited).sort().join(",")}`,
        ].join("|");
    }, [messages]);

    const reportedMutationSignature = useRef(projectMutationSignature);
    useEffect(() => {
        if (reportedMutationSignature.current === projectMutationSignature) {
            return;
        }
        reportedMutationSignature.current = projectMutationSignature;
        onProjectMutated();
    }, [projectMutationSignature, onProjectMutated]);

    useEffect(() => {
        if (!isSideChat) setCurrentChatId(activeChatId || null);
    }, [activeChatId, isSideChat, setCurrentChatId]);

    useEffect(() => {
        if (claimCreated(activeChatId)) {
            const firstUserMessage = messages.find(
                (message) => message.role === "user",
            );
            setChatModel(firstUserMessage?.model ?? null);
            setChatReasoningLevel(firstUserMessage?.reasoning ?? null);
            return;
        }
        let cancelled = false;
        setChatLoaded(false);
        setChatTitle(null);
        setChatModel(undefined);
        setChatReasoningLevel(undefined);
        setMessages([]);
        hasInitialScrolled.current = false;

        if (!activeChatId) {
            setChatLoaded(true);
            return () => {
                cancelled = true;
            };
        }

        loadAssistantChat(activeChatId)
            .then(({ chat, messages: loaded }) => {
                if (cancelled) return;
                setChatTitle(chat.title);
                setChatModel(chat.model ?? null);
                setChatReasoningLevel(chat.reasoning_level ?? null);
                setMessages(loaded);
                setProjectChats((current) => {
                    if (!current) return current;
                    const nextChat = { ...chat, project_id: projectId };
                    return current.some((entry) => entry.id === chat.id)
                        ? current.map((entry) =>
                              entry.id === chat.id ? nextChat : entry,
                          )
                        : [nextChat, ...current];
                });
            })
            .catch(() => {
                if (cancelled) return;
                // A chat that cannot be shown gives way: the side chat to a
                // new one in place, the primary to the project's chat list.
                if (isSideChat) openChat("");
                else router.replace(`/projects/${projectId}/assistant`);
            })
            .finally(() => {
                if (!cancelled) setChatLoaded(true);
            });

        return () => {
            cancelled = true;
        };
    }, [activeChatId]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const match = chats.find((chat) => chat.id === activeChatId);
        if (match?.title) setChatTitle(match.title);
    }, [activeChatId, chats]);

    useEffect(() => {
        const pendingMessage = pendingInitialUserMessageRef.current;
        if (
            pendingMessage &&
            !hasAutoSent.current &&
            !isResponseLoading &&
            messages.length === 1
        ) {
            hasAutoSent.current = true;
            pendingInitialUserMessageRef.current = null;
            setNewChatMessages(null);
            void handleChat(pendingMessage);
        }
    }, [messages.length, isResponseLoading, handleChat, setNewChatMessages]);

    useEffect(() => {
        const last = messages[messages.length - 1];
        if (last?.role === "user") return scrollLatestUserToTop();
    }, [messages, scrollLatestUserToTop]);

    useEffect(() => {
        if (!chatLoaded || hasInitialScrolled.current || messages.length === 0)
            return;
        const container = messagesContainerRef.current;
        const el = latestUserMessageRef.current;
        if (!container || !el) return;
        return scrollLatestUserToTop("auto", () => {
            hasInitialScrolled.current = true;
        });
    }, [activeChatId, chatLoaded, messages.length, scrollLatestUserToTop]);

    useEffect(() => {
        if (chatLoaded && isResponseLoading) return scrollLatestUserToTop();
    }, [chatLoaded, isResponseLoading, scrollLatestUserToTop]);

    // The composer mounts once the role is known; the passage waits for it.
    const addedExcerptIdRef = useRef<number | null>(null);
    useEffect(() => {
        const input = chatInputRef.current;
        if (!incomingExcerpt || !input || canSendChat !== true) return;
        if (addedExcerptIdRef.current === incomingExcerpt.id) return;
        addedExcerptIdRef.current = incomingExcerpt.id;
        input.addExcerpt(incomingExcerpt.excerpt);
        onIncomingExcerptAdded?.();
    }, [incomingExcerpt, canSendChat, composerReady, onIncomingExcerptAdded]);

    const handleSubmit = useCallback(
        (message: Message, options?: Parameters<typeof handleChat>[1]) => {
            if (!displayedDoc) return handleChat(message, options);
            return handleChat(message, { ...options, displayedDoc });
        },
        [displayedDoc, handleChat],
    );

    const handleChatDrop = (event: React.DragEvent) => {
        if (!isChatAttachmentDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        setChatDragOver(false);
        const docId = event.dataTransfer.getData("application/mike-doc");
        if (!docId) {
            const files = Array.from(event.dataTransfer.files);
            if (files.length > 0) chatInputRef.current?.addFiles(files);
            return;
        }
        const doc = project?.documents?.find((d) => d.id === docId);
        if (doc) chatInputRef.current?.addDoc(doc);
    };

    // ── Chat actions ──────────────────────────────────────────────────────────
    function navigateToChat(nextChatId: string) {
        onClearResponseStatus(nextChatId);
        if (nextChatId === activeChatId) return;
        // Leaving a thread is not Stop: detach so the answer still finishes
        // and is persisted server-side, instead of being cut to
        // "Cancelled by user." in the chat the user just left.
        detach();
        openChat(nextChatId);
    }

    function handleNewChat() {
        if (!canEditContent) {
            if (project) onEditorGate("create a chat");
            return;
        }
        resetChat();
        openChat("");
        setComposerResetKey((current) => current + 1);
    }

    async function handleDeleteChat() {
        if (!activeChatId) return;
        if (!canDeleteChat) {
            // Only accuse somebody of lacking a role once we know they do:
            // `projectRole` is null for the whole load window, and a refusal
            // popup raised then is a guess.
            if (projectRole) onOwnerGate("delete this chat");
            return;
        }
        setDeletingChat(true);
        try {
            await deleteChat(activeChatId);
            if (isSideChat) {
                resetChat();
                openChat("");
                setProjectChats((current) =>
                    current
                        ? current.filter((chat) => chat.id !== activeChatId)
                        : current,
                );
            } else {
                router.push(`/projects/${projectId}/assistant`);
            }
        } catch (error) {
            // Without this the refusal was an unhandled rejection and the
            // panel just sat there, indistinguishable from a slow delete.
            onActionError({
                title: "Chat not deleted",
                message: userFacingApiError(
                    error,
                    "The chat could not be deleted. Please try again.",
                ),
            });
        } finally {
            setDeletingChat(false);
        }
    }

    async function handleRenameChat(nextTitle?: string) {
        if (!activeChatId) return;
        if (!canEditContent) {
            if (projectRole) onEditorGate("rename this chat");
            return;
        }
        if (nextTitle === undefined) {
            setChatTitleEdit({
                chatId: activeChatId,
                title: chatTitle ?? "New Chat",
            });
            return;
        }
        setChatTitleEdit(null);
        const trimmed = nextTitle.trim();
        if (!trimmed || trimmed === chatTitle) return;
        const previousTitle = chatTitle;
        const previousUpdatedAt = chats.find(
            (chat) => chat.id === activeChatId,
        )?.updated_at;
        setChatTitle(trimmed);
        setProjectChats((current) =>
            touchChatActivity(
                (current ?? []).map((chat) =>
                    chat.id === activeChatId
                        ? { ...chat, title: trimmed }
                        : chat,
                ),
                activeChatId,
            ),
        );
        try {
            await renameChatInHistory(activeChatId, trimmed);
        } catch (error) {
            // ChatHistoryContext rethrows so the calling surface can speak.
            // Unhandled, the header title stayed changed while the switcher
            // row snapped back — the user saw two different titles and no
            // reason for either.
            if (activeChatIdRef.current === activeChatId) {
                setChatTitle((current) =>
                    current === trimmed ? previousTitle : current,
                );
            }
            setProjectChats((current) =>
                sortChatsByActivity(
                    (current ?? []).map((chat) =>
                        chat.id === activeChatId && chat.title === trimmed
                            ? {
                                  ...chat,
                                  title: previousTitle,
                                  updated_at: previousUpdatedAt,
                              }
                            : chat,
                    ),
                ),
            );
            onActionError({
                title: "Chat not renamed",
                message: userFacingApiError(
                    error,
                    "The chat could not be renamed. Please try again.",
                ),
            });
        }
    }

    return (
        <>
            <div
                ref={panelRef}
                data-chat-pane={isSideChat ? "side" : "primary"}
                style={{ width }}
                className={cn(
                    "relative flex shrink-0 flex-col overflow-hidden",
                    roundedClassName,
                    LIQUID_GLASS_FLAT_CLASS,
                )}
                onPointerDownCapture={onActivate}
                onFocusCapture={onActivate}
                onDragEnter={(event) => {
                    if (!isChatAttachmentDrag(event.dataTransfer)) return;
                    event.preventDefault();
                    if (isExternalFileDrag(event.dataTransfer)) {
                        setChatDragOver(true);
                    }
                }}
                onDragOver={(event) => {
                    if (!isChatAttachmentDrag(event.dataTransfer)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                    if (isExternalFileDrag(event.dataTransfer)) {
                        setChatDragOver(true);
                    }
                }}
                onDragLeave={(event) => {
                    if (
                        !event.currentTarget.contains(
                            event.relatedTarget as Node,
                        )
                    ) {
                        setChatDragOver(false);
                    }
                }}
                onDrop={handleChatDrop}
            >
                {chatDragOver && (
                    <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-white/50 backdrop-blur-md">
                        <p className="font-serif text-xl text-gray-900">
                            Drop files here to add to chat
                        </p>
                    </div>
                )}
                <div className="absolute inset-x-0 top-0 z-40">
                    <ChatPanelHeader
                        chats={chats}
                        currentChatId={activeChatId}
                        currentTitle={chatTitle}
                        loading={chatsLoading}
                        responseStatuses={responseStatuses}
                        hiddenChatId={hiddenChatId}
                        onClose={onClose}
                        newChatDisabled={!canEditContent}
                        onLoad={navigateToChat}
                        onNewChat={handleNewChat}
                        titleEdit={
                            editingChatTitle
                                ? {
                                      value: editingChatTitle.title,
                                      onChange: (title) =>
                                          setChatTitleEdit({
                                              ...editingChatTitle,
                                              title,
                                          }),
                                      onSave: () =>
                                          void handleRenameChat(
                                              editingChatTitle.title,
                                          ),
                                      onCancel: () => setChatTitleEdit(null),
                                  }
                                : undefined
                        }
                        actions={
                            <HeaderActionsMenu
                                triggerClassName="h-6 w-6"
                                onCloseAutoFocus={(event) => {
                                    if (editingChatTitle)
                                        event.preventDefault();
                                }}
                                items={[
                                    ...(onOpenSideChat
                                        ? [
                                              {
                                                  label: "Open side chat",
                                                  icon: Columns2,
                                                  onSelect: onOpenSideChat,
                                              },
                                          ]
                                        : []),
                                    {
                                        label: "Rename",
                                        icon: Pencil,
                                        onSelect: () => void handleRenameChat(),
                                        disabled:
                                            !chatLoaded ||
                                            !activeChatId ||
                                            !roleKnown,
                                    },
                                    {
                                        label: "Memory",
                                        icon: Brain,
                                        onSelect: onOpenMemory,
                                        disabled: !project,
                                    },
                                    {
                                        label: deletingChat
                                            ? "Deleting..."
                                            : "Delete",
                                        icon: Trash2,
                                        onSelect: () => void handleDeleteChat(),
                                        disabled:
                                            deletingChat ||
                                            !chatLoaded ||
                                            !activeChatId ||
                                            !roleKnown,
                                        variant: "danger" as const,
                                    },
                                ].filter((item) =>
                                    activeChatId
                                        ? true
                                        : item.label === "Memory" ||
                                          item.label === "Open side chat",
                                )}
                            />
                        }
                    />
                </div>
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute left-0 right-3 top-0 z-30 h-16 bg-gradient-to-b from-app-surface/85 via-app-surface/60 via-50% to-transparent"
                />
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute bottom-0 left-0 right-3 z-20 h-28 bg-gradient-to-t from-app-surface to-transparent"
                />

                {/* Messages / greeting / shimmer */}
                {!chatLoaded ? (
                    <div className="flex-1 space-y-4 px-4 pb-4 pt-16">
                        <div className="flex justify-end">
                            <div className="bg-gray-100 rounded-2xl p-4 w-3/4">
                                <div className="theme-shimmer h-3 bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded w-full" />
                            </div>
                        </div>
                        <div className="space-y-2">
                            {[1, 2, 3].map((i) => (
                                <div
                                    key={i}
                                    className={`theme-shimmer h-3 bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded ${i === 3 ? "w-4/6" : "w-full"}`}
                                />
                            ))}
                        </div>
                    </div>
                ) : messages.length === 0 ? (
                    <div className="flex-1 flex flex-col min-h-0">
                        <AssistantGreeting username={username} />
                    </div>
                ) : (
                    <div
                        ref={messagesContainerRef}
                        className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 pt-[72px] md:space-y-8 md:pt-20"
                        style={{
                            paddingBottom: DEFAULT_ASSISTANT_BOTTOM_PADDING,
                            scrollbarGutter: "stable",
                        }}
                    >
                        {(() => {
                            const lastUserIdx = messages
                                .map((m) => m.role)
                                .lastIndexOf("user");
                            const lastAssistantIdx = messages
                                .map((m) => m.role)
                                .lastIndexOf("assistant");
                            // The message still waiting on the user's input
                            // or approval, if any.
                            const pendingAskInputIndex =
                                findPendingAskInput(messages)?.messageIndex ??
                                -1;
                            return messages.map((msg, i) =>
                                msg.role === "user" ? (
                                    <div
                                        key={i}
                                        ref={
                                            i === lastUserIdx
                                                ? latestUserMessageRef
                                                : null
                                        }
                                    >
                                        <UserMessage
                                            content={msg.content ?? ""}
                                            files={msg.files}
                                            workflow={msg.workflow}
                                            onFileClick={(file) => {
                                                if (!file.document_id) return;
                                                onOpenDocument({
                                                    documentId:
                                                        file.document_id,
                                                    filename: file.filename,
                                                    versionId: null,
                                                    versionNumber: null,
                                                });
                                            }}
                                        />
                                    </div>
                                ) : (
                                    <AssistantMessage
                                        key={i}
                                        events={msg.events}
                                        isStreaming={
                                            i === messages.length - 1 &&
                                            isResponseLoading
                                        }
                                        awaitingInput={
                                            i === pendingAskInputIndex
                                        }
                                        isError={!!msg.error}
                                        citations={msg.citations}
                                        citationStatus={msg.citationStatus}
                                        activeCitation={activeCitation}
                                        onCitationClick={onCitationClick}
                                        onCaseClick={onCaseClick}
                                        onOpenCitationSource={(citation) => {
                                            void onCitationClick(
                                                citation,
                                                false,
                                            );
                                        }}
                                        minHeight={
                                            i === lastAssistantIdx
                                                ? minHeight
                                                : "0px"
                                        }
                                        onEditViewClick={onEditViewClick}
                                        onEditResolveStart={onEditResolveStart}
                                        isEditReloading={(editId) =>
                                            !!resolvingEdits[editId]
                                        }
                                        isDocReloading={(documentId) =>
                                            Object.values(
                                                resolvingEdits,
                                            ).includes(documentId)
                                        }
                                        resolvedEditStatuses={
                                            resolvedEditStatuses
                                        }
                                        onOpenDocument={onOpenDocument}
                                        onEditError={onEditError}
                                        onEditResolved={onEditResolved}
                                    />
                                ),
                            );
                        })()}
                    </div>
                )}

                {/* ChatInput */}
                <ResponseSelectionMenuUI
                    canAsk={canSendChat === true}
                    scopeRef={panelRef}
                    onAskInSideChat={onAskInSideChat}
                    onAddExcerpt={(excerpt) =>
                        chatInputRef.current?.addExcerpt(excerpt)
                    }
                />
                {composerReady && (
                    <div className="absolute bottom-3 left-3 right-3 z-30">
                        <div className="pointer-events-none absolute -bottom-3 inset-x-0 z-0 h-7 bg-app-surface" />
                        <div className="relative z-20 w-full">
                            <ChatInputPrompt
                                messages={messages}
                                chatKey={activeChatId}
                                canSend={canSendChat}
                                chatLoading={!chatLoaded}
                                onSubmit={(response, content, files) => {
                                    void handleSubmit(
                                        { role: "user", content, files },
                                        { askInputsResponse: response },
                                    );
                                }}
                                onCancel={cancel}
                            >
                                <ChatInput
                                    key={`${activeChatId || "new"}:${composerResetKey}`}
                                    ref={chatInputRef}
                                    onSubmit={handleSubmit}
                                    onCancel={cancel}
                                    isLoading={isResponseLoading}
                                    chatKey={activeChatId}
                                    chatModel={chatModel}
                                    chatReasoningLevel={chatReasoningLevel}
                                    canSend={canSendChat}
                                    chatLoading={!chatLoaded}
                                    enableGlobalFileDrop={false}
                                    dropUploadsToProject={false}
                                    projectId={projectId}
                                    onDocumentClick={onDocClick}
                                    projectName={project?.name}
                                    projectCmNumber={project?.cm_number}
                                />
                            </ChatInputPrompt>
                        </div>
                    </div>
                )}
            </div>
            <ApiKeyMissingPopup
                open={rejectedApiKey !== null}
                title="API key rejected"
                message={`${
                    rejectedKeyProvider
                        ? `The ${providerLabel(rejectedKeyProvider)} API key`
                        : "That API key"
                } was rejected. If it is your own key, check it in Settings; otherwise contact your administrator.`}
                onClose={dismissInvalidApiKey}
            />
        </>
    );
}
