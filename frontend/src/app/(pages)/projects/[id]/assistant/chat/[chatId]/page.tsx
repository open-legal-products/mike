"use client";

import {
    use,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
} from "react";
import { useRouter } from "next/navigation";
import {
    ArrowUpRight,
    Brain,
    ChevronLeft,
    ChevronRight,
    FolderOpen,
    FolderPlus,
    Pencil,
    Trash2,
} from "lucide-react";
import {
    deleteChat,
    deleteDocument,
    getChat,
    getDocument,
    getProject,
    listProjectChats,
    uploadProjectDocuments,
    createProjectFolder,
    renameProjectFolder,
    renameProjectDocument,
    deleteProjectFolder,
    moveDocumentToFolder,
    moveSubfolderToFolder,
    resolveProjectFolderPath,
} from "@/app/lib/mikeApi";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { useAssistantMessageLayout } from "@/app/hooks/useAssistantMessageLayout";
import { useProjectPicker } from "@/app/hooks/useProjectPicker";
import {
    isChatAttachmentDrag,
    isExternalFileDrag,
    isDocumentViewerDrag,
    isProjectItemDrag,
} from "@/app/lib/projectDragTypes";
import { useExplorerDownload } from "@/app/hooks/useExplorerDownload";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { UserMessage } from "@/app/components/assistant/UserMessage";
import { AssistantMessage } from "@/app/components/assistant/AssistantMessage";
import { ChatInput } from "@/app/components/assistant/ChatInput";
import { ChatInputPrompt } from "@/app/components/assistant/ChatInputPrompt";
import type { ChatInputHandle } from "@/app/components/assistant/ChatInput";
import {
    ProjectExplorer,
    type ProjectExplorerHandle,
} from "@/app/components/projects/ProjectExplorer";
import { ProjectMemoryModal } from "@/app/components/projects/ProjectMemoryModal";
import { ChatPanelHeader } from "@/app/components/shared/ChatPanelHeader";
import { ProjectDocumentTabs } from "@/app/components/projects/ProjectDocumentTabs";
import {
    ProjectDocumentPanels,
    type ProjectDocumentTab,
} from "@/app/components/projects/ProjectDocumentPanels";
import { useProjectDocumentRefresh } from "@/app/hooks/useProjectDocumentRefresh";
import { invalidateDocxBytes } from "@/app/hooks/useFetchDocxBytes";
import { reorderTabs } from "@/app/lib/reorderTabs";
import { AddDocumentsModal } from "@/app/components/modals/AddDocumentsModal";
import { ProjectPickerModal } from "@/app/components/modals/ProjectPickerModal";
import { DocumentUploadMenu } from "@/app/components/shared/DocumentUploadMenu";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { PermissionDeniedPopup } from "@/app/components/popups/PermissionDeniedPopup";
import { MikeIcon } from "@/app/components/chat/mike-icon";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { useSidebar } from "@/app/contexts/SidebarContext";
import { HeaderActionsMenu } from "@/app/components/shared/HeaderActionsMenu";
import type {
    Chat,
    CitationQuote,
    Citation,
    Document,
    EditAnnotation,
    Message,
    Project,
} from "@/app/components/shared/types";
import { expandCitationToEntries } from "@/app/components/shared/types";
import {
    INITIAL_FOLDER_DELETE_DIALOG_STATE,
    clearDeletedDocumentId,
    clearDeletedDocumentTarget,
    folderDeleteDialogReducer,
    removeDeletedDocumentTabs,
} from "@/app/lib/folderDeleteState";
import { can, roleFromLoaded } from "@/app/lib/permissions";
import { LIQUID_GLASS_FLAT_CLASS } from "@/app/components/ui/liquid-surface";
import { cn } from "@/app/lib/utils";
import { readDocumentDragPayload } from "@/app/lib/docTableSelection";
import { userFacingApiError } from "@/app/lib/userFacingError";
import {
    collectDroppedDocumentUploadEntries,
    documentUploadEntriesFromFiles,
    documentUploadFolderSegments,
    type DocumentUploadEntry,
} from "@/app/lib/documentDirectoryUpload";
import { SUPPORTED_DOCUMENT_ACCEPT } from "@/app/lib/documentUploadValidation";

interface Props {
    params: Promise<{ id: string; chatId?: string }>;
}

type EditScrollTarget = {
    key: string;
    documentId: string;
    inserted_text?: string;
    deleted_text?: string;
    ins_w_id?: string | null;
    del_w_id?: string | null;
};

const ICON_SIZE = 28;
const GAP = 14;
const EXPLORER_MIN = 160;
const EXPLORER_DEFAULT = 280;
const DOCUMENT_MIN = 320;
const CHAT_MIN = 320;
const CHAT_DEFAULT = 420;
const PANEL_DIVIDERS_WIDTH = 12;
const COLLAPSED_EXPLORER_FOOTPRINT = 42;
const DEFAULT_ASSISTANT_BOTTOM_PADDING = 116;
const ASSISTANT_HEADER_HEIGHT = 48;

type WorkspacePanelWidths = {
    explorer: number;
    chat: number;
};

function fitExpandedPanelWidths(
    widths: WorkspacePanelWidths,
    workspaceWidth: number,
): WorkspacePanelWidths {
    const availableWidth = workspaceWidth - DOCUMENT_MIN - PANEL_DIVIDERS_WIDTH;
    const currentTotal = widths.explorer + widths.chat;
    if (currentTotal <= availableWidth) return widths;

    const minimumTotal = EXPLORER_MIN + CHAT_MIN;
    if (availableWidth <= minimumTotal) {
        return { explorer: EXPLORER_MIN, chat: CHAT_MIN };
    }

    const availableExtra = availableWidth - minimumTotal;
    const explorerExtra = widths.explorer - EXPLORER_MIN;
    const chatExtra = widths.chat - CHAT_MIN;
    const currentExtra = explorerExtra + chatExtra;
    if (currentExtra <= 0) return widths;

    const scale = availableExtra / currentExtra;
    return {
        explorer: EXPLORER_MIN + explorerExtra * scale,
        chat: CHAT_MIN + chatExtra * scale,
    };
}

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

/** Drag-handle divider for resizing panels */
function Divider({ onDrag }: { onDrag: (dx: number) => void }) {
    const dragging = useRef(false);
    const lastX = useRef(0);
    const [isDragging, setIsDragging] = useState(false);

    const onMouseDown = (e: React.MouseEvent) => {
        dragging.current = true;
        setIsDragging(true);
        lastX.current = e.clientX;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    };

    useEffect(() => {
        function onMouseMove(e: MouseEvent) {
            if (!dragging.current) return;
            onDrag(e.clientX - lastX.current);
            lastX.current = e.clientX;
        }
        function onMouseUp() {
            if (!dragging.current) return;
            dragging.current = false;
            setIsDragging(false);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        }
        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
        return () => {
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
        };
    }, [onDrag]);

    return (
        <div className="relative z-10 w-1.5 shrink-0">
            <div
                onMouseDown={onMouseDown}
                className="absolute inset-y-0 -left-1 -right-1 flex cursor-col-resize items-stretch justify-center"
            >
                {isDragging && (
                    <div className="w-1 bg-blue-500 transition-colors" />
                )}
            </div>
        </div>
    );
}

export default function ProjectAssistantChatPage({ params }: Props) {
    const { id: projectId, chatId: routeChatId = "" } = use(params);
    const router = useRouter();

    const { setSidebarOpen } = useSidebar();
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const username =
        profile?.displayName?.trim() || user?.email?.split("@")[0] || "there";
    const explorerDownload = useExplorerDownload();

    const [project, setProject] = useState<Project | null>(null);
    const [activeChatId, setActiveChatId] = useState(routeChatId);
    const activeChatIdRef = useRef(activeChatId);
    useLayoutEffect(() => {
        activeChatIdRef.current = activeChatId;
    }, [activeChatId]);
    const [projectChats, setProjectChats] = useState<Chat[] | null>(null);
    const [chatTitle, setChatTitle] = useState<string | null>(null);
    const [chatTitleEdit, setChatTitleEdit] = useState<{
        chatId: string;
        title: string;
    } | null>(null);
    const editingChatTitle =
        chatTitleEdit?.chatId === activeChatId ? chatTitleEdit : null;
    const [chatOwnerId, setChatOwnerId] = useState<string | null>(null);
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const [editorGateAction, setEditorGateAction] = useState<string | null>(
        null,
    );
    const [chatLoaded, setChatLoaded] = useState(false);
    const [deletingChat, setDeletingChat] = useState(false);
    const [composerResetKey, setComposerResetKey] = useState(0);
    const [projectMemoryOpen, setProjectMemoryOpen] = useState(false);
    const [folderDeleteDialog, dispatchFolderDeleteDialog] = useReducer(
        folderDeleteDialogReducer,
        INITIAL_FOLDER_DELETE_DIALOG_STATE,
    );
    const pendingDeleteFolder = folderDeleteDialog.pending;
    const pendingDeleteFolderStatus = folderDeleteDialog.status;
    const folderDeleteDismissTimerRef = useRef<number | null>(null);

    // Panel widths
    const [panelWidths, setPanelWidths] = useState<WorkspacePanelWidths>({
        explorer: EXPLORER_DEFAULT,
        chat: CHAT_DEFAULT,
    });
    const explorerWidth = panelWidths.explorer;
    const chatWidth = panelWidths.chat;
    const [explorerCollapsed, setExplorerCollapsed] = useState(false);
    const workspaceRef = useRef<HTMLDivElement>(null);

    // Upload state
    const fileInputRef = useRef<HTMLInputElement>(null);
    const folderInputRef = useRef<HTMLInputElement>(null);
    const projectExplorerRef = useRef<ProjectExplorerHandle>(null);
    const [addDocumentsOpen, setAddDocumentsOpen] = useState(false);
    const projectPicker = useProjectPicker();
    const [uploadingDocuments, setUploadingDocuments] = useState<
        Array<{ clientId: string; filename: string }>
    >([]);
    const [explorerDragOver, setExplorerDragOver] = useState(false);
    const [chatDragOver, setChatDragOver] = useState(false);
    const [documentDragOver, setDocumentDragOver] = useState(false);
    const [documentDropError, setDocumentDropError] = useState<string | null>(
        null,
    );

    // Tabs
    const [tabs, setTabs] = useState<ProjectDocumentTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [activeQuotes, setActiveQuotes] = useState<CitationQuote[] | null>(
        null,
    );
    const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
    const [editScrollTarget, setEditScrollTarget] =
        useState<EditScrollTarget | null>(null);

    const activeTab = tabs.find((t) => t.documentId === activeTabId) ?? null;
    const chatInputRef = useRef<ChatInputHandle | null>(null);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const latestUserMessageRef = useRef<HTMLDivElement>(null);

    const {
        setCurrentChatId,
        newChatMessages,
        setNewChatMessages,
        chats,
        renameChat: renameChatInHistory,
    } = useChatHistoryContext();
    const [initialMessages] = useState<Message[]>(newChatMessages ?? []);
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
    const createdChatIdRef = useRef<string | null>(null);
    const adoptCreatedChat = useCallback(
        (chatId: string) => {
            createdChatIdRef.current = chatId;
            setChatOwnerId(user?.id ?? null);
            setActiveChatId(chatId);
            window.history.pushState(
                null,
                "",
                `/projects/${projectId}/assistant/chat/${chatId}`,
            );
        },
        [projectId, user?.id],
    );
    const {
        messages,
        isResponseLoading,
        handleChat,
        setMessages,
        cancel,
        resetChat,
    } = useAssistantChat({
        initialMessages,
        onChatCreated: adoptCreatedChat,
        chatId: activeChatId || undefined,
        projectId,
    });
    const availableProjectChats = useMemo(() => {
        const byId = new Map<string, Chat>();
        for (const chat of chats ?? []) {
            if (chat.project_id === projectId) byId.set(chat.id, chat);
        }
        for (const chat of projectChats ?? []) byId.set(chat.id, chat);
        return Array.from(byId.values()).sort(
            (a, b) =>
                (Date.parse(b.created_at ?? "") || 0) -
                (Date.parse(a.created_at ?? "") || 0),
        );
    }, [chats, projectChats, projectId]);

    // Server ladder: writing to a project chat needs content.edit on the
    // project, except that the chat's own creator may always continue it.
    //
    // While the project is still loading the role is unknown, and unknown is
    // not a licence. `!project ||` made it one: for the whole load window a
    // viewer's composer was live and their upload button enabled, and the
    // refusal only arrived from the server afterwards. The composer now stays
    // closed until we know — the read-only placeholder is the same one a
    // viewer sees, so the transition on a load is a placeholder swap rather
    // than a control appearing that was never theirs.
    const projectRole = roleFromLoaded(project);
    const canEditContent = can(projectRole, "content.edit");
    const canManageProject = can(projectRole, "access.manage");
    // The chat's own creator keeps writing to it whatever their project role,
    // because the server puts a row's creator at the top of that row's ladder.
    // That exception is knowable without the project, so it still applies
    // during the load window.
    const canSendChat =
        canEditContent || (!!chatOwnerId && chatOwnerId === user?.id);
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

    const clearFolderDeleteDismissTimer = useCallback(() => {
        if (folderDeleteDismissTimerRef.current === null) return;
        clearTimeout(folderDeleteDismissTimerRef.current);
        folderDeleteDismissTimerRef.current = null;
    }, []);

    useEffect(() => {
        return () => clearFolderDeleteDismissTimer();
    }, [clearFolderDeleteDismissTimer]);

    useEffect(() => {
        setChatTitleEdit(null);
    }, [activeChatId]);

    useEffect(() => {
        if (activeTabId) return;
        setActiveQuotes(null);
        setEditScrollTarget(null);
    }, [activeTabId]);

    useEffect(() => {
        setSidebarOpen(false);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const projectRequestGeneration = useRef(0);
    const refreshProject = useCallback(async (documentIdToRefresh?: string) => {
        const generation = ++projectRequestGeneration.current;
        try {
            const loaded = await getProject(projectId);
            if (generation === projectRequestGeneration.current) {
                setProject(loaded);
            }
        } catch {
            // Keep the current workspace usable when a background check fails.
        } finally {
            if (documentIdToRefresh) {
                setTabs((current) =>
                    current.map((tab) =>
                        tab.documentId === documentIdToRefresh
                            ? { ...tab, refetchKey: (tab.refetchKey ?? 0) + 1 }
                            : tab,
                    ),
                );
            }
        }
    }, [projectId]);
    useEffect(() => {
        return () => {
            projectRequestGeneration.current += 1;
        };
    }, [projectId]);
    useProjectDocumentRefresh(refreshProject, activeTabId);

    useEffect(() => {
        let cancelled = false;
        listProjectChats(projectId)
            .then((loaded) => {
                if (!cancelled) setProjectChats(loaded);
            })
            .catch(() => {
                if (!cancelled) setProjectChats([]);
            });
        return () => {
            cancelled = true;
        };
    }, [projectId]);

    // Whenever the assistant mutates project documents — creating a new
    // doc, creating a new version via edit_document, or replicating a doc —
    // refresh the project so the explorer picks up the new/changed files
    // without a manual reload. Keyed by completed mutation events only, so
    // we refetch once the backend has finished persisting the change.
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

    useEffect(() => {
        void refreshProject();
    }, [projectMutationSignature, refreshProject]);

    useEffect(() => {
        setActiveChatId(routeChatId);
    }, [routeChatId]);

    useEffect(() => {
        setCurrentChatId(activeChatId || null);
    }, [activeChatId, setCurrentChatId]);

    useEffect(() => {
        if (activeChatId && createdChatIdRef.current === activeChatId) {
            createdChatIdRef.current = null;
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
        setChatOwnerId(null);
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

        getChat(activeChatId)
            .then(({ chat, messages: loaded }) => {
                if (cancelled) return;
                setChatTitle(chat.title);
                setChatOwnerId(chat.user_id ?? null);
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
                if (!cancelled)
                    router.replace(`/projects/${projectId}/assistant`);
            })
            .finally(() => {
                if (!cancelled) setChatLoaded(true);
            });

        return () => {
            cancelled = true;
        };
    }, [activeChatId]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const match = availableProjectChats.find(
            (chat) => chat.id === activeChatId,
        );
        if (match?.title) setChatTitle(match.title);
    }, [activeChatId, availableProjectChats]);

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
    }, [chatLoaded, messages.length, scrollLatestUserToTop]);

    useEffect(() => {
        if (isResponseLoading) return scrollLatestUserToTop();
    }, [isResponseLoading, scrollLatestUserToTop]);

    // ── Tabs ──────────────────────────────────────────────────────────────────
    function openTab(
        docId: string,
        filename: string,
        quotes?: CitationQuote[],
        versionId?: string | null,
        fileType?: string | null,
    ) {
        setTabs((prev) => {
            const existing = prev.find((t) => t.documentId === docId);
            if (existing) {
                if (
                    (versionId !== undefined &&
                        existing.versionId !== versionId) ||
                    (fileType !== undefined && existing.fileType !== fileType)
                ) {
                    return prev.map((t) =>
                        t.documentId === docId
                            ? {
                                  ...t,
                                  versionId:
                                      versionId === undefined
                                          ? t.versionId
                                          : versionId,
                                  fileType: fileType ?? t.fileType,
                              }
                            : t,
                    );
                }
                return prev;
            }
            return [
                ...prev,
                { documentId: docId, filename, versionId, fileType },
            ];
        });
        setActiveTabId(docId);
        setActiveQuotes(quotes && quotes.length ? quotes : null);
        setSelectedDocId(docId);
    }

    function closeTab(docId: string) {
        if (activeTabId === docId) {
            const idx = tabs.findIndex((tab) => tab.documentId === docId);
            const fallback = idx < 0 ? null : tabs[idx + 1] ?? tabs[idx - 1] ?? null;
            setActiveTabId(fallback?.documentId ?? null);
            setActiveQuotes(null);
            setSelectedDocId(fallback?.documentId ?? null);
        }
        setTabs((prev) => prev.filter((tab) => tab.documentId !== docId));
    }

    function switchTab(docId: string) {
        setActiveTabId(docId);
        setActiveQuotes(null);
        setSelectedDocId(docId);
    }

    // ── Handlers ──────────────────────────────────────────────────────────────
    const handleSubmit = useCallback(
        (message: Message, options?: Parameters<typeof handleChat>[1]) => {
            if (!activeTab) return handleChat(message, options);
            return handleChat(message, {
                ...options,
                displayedDoc: {
                    filename: activeTab.filename,
                    documentId: activeTab.documentId,
                },
            });
        },
        [activeTab, handleChat],
    );

    const handleDocClick = (doc: Document) => {
        openTab(doc.id, doc.filename, undefined, null, doc.file_type);
    };

    const handleCitationClick = (citation: Citation) => {
        if (citation.kind === "case") return;
        openTab(
            citation.document_id,
            citation.filename,
            expandCitationToEntries(citation),
        );
    };

    const handleOpenDocument = (args: {
        documentId: string;
        filename: string;
        versionId: string | null;
        versionNumber: number | null;
    }) => {
        openTab(args.documentId, args.filename, undefined, args.versionId);
    };

    const handleEditViewClick = (ann: EditAnnotation, filename: string) => {
        openTab(ann.document_id, filename, undefined, ann.version_id ?? null);
        setEditScrollTarget({
            key: `${ann.edit_id}-${Date.now()}`,
            documentId: ann.document_id,
            inserted_text: ann.inserted_text,
            deleted_text: ann.deleted_text,
            ins_w_id: ann.ins_w_id ?? null,
            del_w_id: ann.del_w_id ?? null,
        });
    };

    const patchTab = useCallback(
        (documentId: string, patch: Partial<ProjectDocumentTab>) => {
            setTabs((prev) =>
                prev.map((t) =>
                    t.documentId === documentId ? { ...t, ...patch } : t,
                ),
            );
        },
        [],
    );

    const handleEditError = (args: { documentId: string; message: string }) => {
        patchTab(args.documentId, { warning: args.message });
    };

    const dismissTabWarning = useCallback(
        (documentId: string) => {
            patchTab(documentId, { warning: null });
        },
        [patchTab],
    );

    const handleEditResolved = (args: { documentId: string }) => {
        invalidateDocxBytes(args.documentId);
        // Apply metadata and the forced refresh together to avoid downloading twice.
        void refreshProject(args.documentId);
    };

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
        if (nextChatId === activeChatId) return;
        cancel();
        setActiveChatId(nextChatId);
        window.history.pushState(
            null,
            "",
            `/projects/${projectId}/assistant/chat/${nextChatId}`,
        );
    }

    function handleNewChat() {
        if (!canEditContent) {
            if (project) setEditorGateAction("create a chat");
            return;
        }
        resetChat();
        setActiveChatId("");
        setComposerResetKey((current) => current + 1);
        window.history.pushState(
            null,
            "",
            `/projects/${projectId}/assistant/chat`,
        );
    }

    async function handleDeleteChat() {
        if (!activeChatId) return;
        if (chatOwnerId && user?.id && chatOwnerId !== user.id) {
            setOwnerOnlyAction("delete this chat");
            return;
        }
        setDeletingChat(true);
        try {
            await deleteChat(activeChatId);
            router.push(`/projects/${projectId}/assistant`);
        } finally {
            setDeletingChat(false);
        }
    }

    async function handleRenameChat(nextTitle?: string) {
        if (!activeChatId) return;
        if (chatOwnerId && user?.id && chatOwnerId !== user.id) {
            setOwnerOnlyAction("rename this chat");
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
        setChatTitle(trimmed);
        setProjectChats((current) =>
            (current ?? []).map((chat) =>
                chat.id === activeChatId ? { ...chat, title: trimmed } : chat,
            ),
        );
        try {
            await renameChatInHistory(activeChatId, trimmed);
        } catch {
            if (activeChatIdRef.current === activeChatId) {
                setChatTitle((current) =>
                    current === trimmed ? previousTitle : current,
                );
            }
            setProjectChats((current) =>
                (current ?? []).map((chat) =>
                    chat.id === activeChatId && chat.title === trimmed
                        ? { ...chat, title: previousTitle }
                        : chat,
                ),
            );
        }
    }

    // ── Upload ────────────────────────────────────────────────────────────────
    function addUploadedDocuments(documents: Document[]) {
        if (documents.length === 0) return;
        setProject((current) => {
            if (!current) return current;
            const nextDocuments = [...(current.documents ?? [])];
            const knownIds = new Set(
                nextDocuments.map((document) => document.id),
            );
            for (const document of documents) {
                if (knownIds.has(document.id)) continue;
                knownIds.add(document.id);
                nextDocuments.push(document);
            }
            return { ...current, documents: nextDocuments };
        });
    }

    function addResolvedFolders(folders: NonNullable<Project["folders"]>) {
        if (folders.length === 0) return;
        setProject((current) => {
            if (!current) return current;
            const nextFolders = [...(current.folders ?? [])];
            const knownIds = new Set(nextFolders.map((folder) => folder.id));
            for (const folder of folders) {
                if (knownIds.has(folder.id)) continue;
                knownIds.add(folder.id);
                nextFolders.push(folder);
            }
            return { ...current, folders: nextFolders };
        });
    }

    async function uploadEntries(
        entries: DocumentUploadEntry[],
        openInViewer = false,
    ) {
        if (!entries.length) return;
        if (!canEditContent) {
            // Only accuse somebody of lacking a role once we know they do.
            if (projectRole) {
                setEditorGateAction("upload documents to this project");
            }
            return;
        }

        const pendingUploads = entries.map((entry) => ({
            clientId: crypto.randomUUID(),
            filename: entry.file.name,
            entry,
        }));
        const pendingIds = new Set(
            pendingUploads.map((upload) => upload.clientId),
        );
        setUploadingDocuments((current) => [
            ...current,
            ...pendingUploads.map(({ clientId, filename }) => ({
                clientId,
                filename,
            })),
        ]);

        try {
            const folderIdByPath = new Map<string, string>();
            const folderPaths = Array.from(
                new Map(
                    entries.flatMap((entry) => {
                        const segments = documentUploadFolderSegments(entry);
                        return segments.map((_, index) => {
                            const path = segments.slice(0, index + 1);
                            return [path.join("/"), path] as const;
                        });
                    }),
                ).values(),
            ).sort((left, right) => left.length - right.length);

            for (const path of folderPaths) {
                const pathKey = path.join("/");
                const parentPath = path.slice(0, -1);
                const parentFolderId =
                    parentPath.length === 0
                        ? null
                        : (folderIdByPath.get(parentPath.join("/")) ?? null);
                if (parentPath.length > 0 && !parentFolderId) {
                    throw new Error("Upload folder parent was not resolved");
                }

                let resolution = await resolveProjectFolderPath(
                    projectId,
                    [path.at(-1)!],
                    parentFolderId,
                    parentPath.length > 0 ? "reuse" : undefined,
                );
                if (resolution.conflict) {
                    resolution = await resolveProjectFolderPath(
                        projectId,
                        [path.at(-1)!],
                        parentFolderId,
                        "rename",
                    );
                }
                if (resolution.conflict) {
                    throw new Error("Upload folder path conflicted");
                }
                folderIdByPath.set(pathKey, resolution.folder_id);
                addResolvedFolders(resolution.folders);
            }

            const outcomes = await uploadProjectDocuments(
                projectId,
                pendingUploads.map(({ clientId, entry }) => {
                    const folderSegments = documentUploadFolderSegments(entry);
                    return {
                        file: entry.file,
                        clientId,
                        folderId:
                            folderSegments.length === 0
                                ? null
                                : (folderIdByPath.get(
                                      folderSegments.join("/"),
                                  ) ?? null),
                    };
                }),
                {
                    onProgress: (progress) => {
                        if (
                            progress.status === "completed" ||
                            progress.status === "error"
                        ) {
                            setUploadingDocuments((current) =>
                                current.filter(
                                    (upload) =>
                                        upload.clientId !== progress.clientId,
                                ),
                            );
                        }
                        if (
                            progress.status === "completed" &&
                            progress.result
                        ) {
                            addUploadedDocuments([progress.result]);
                        }
                    },
                },
            );
            const uploaded = outcomes.flatMap((outcome) =>
                outcome.status === "completed" && outcome.result
                    ? [outcome.result]
                    : [],
            );
            addUploadedDocuments(uploaded);
            if (openInViewer) {
                uploaded.forEach(handleDocClick);
                if (outcomes.some((outcome) => outcome.status === "error")) {
                    setDocumentDropError(
                        "Some files could not be uploaded. Please try again.",
                    );
                }
            }
        } catch (err) {
            console.error("Upload failed:", err);
            if (openInViewer) {
                setDocumentDropError(
                    userFacingApiError(
                        err,
                        "Files could not be uploaded. Please try again.",
                    ),
                );
            }
        } finally {
            setUploadingDocuments((current) =>
                current.filter((upload) => !pendingIds.has(upload.clientId)),
            );
        }
    }

    function uploadFiles(files: File[]) {
        return uploadEntries(documentUploadEntriesFromFiles(files));
    }

    function selectProject() {
        if (!projectPicker.selectedId) return;
        router.push(`/projects/${projectPicker.selectedId}/assistant/chat`);
    }

    const handleExplorerFileDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        setExplorerDragOver(false);
        const entries = await collectDroppedDocumentUploadEntries(
            e.dataTransfer,
        );
        await uploadEntries(entries);
        // Internal doc/folder moves are handled inside ProjectExplorer (stopPropagation)
    };

    const handleDocumentDrop = async (event: React.DragEvent) => {
        if (!isDocumentViewerDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        setDocumentDragOver(false);
        setDocumentDropError(null);
        try {
            const ids = readDocumentDragPayload(event.dataTransfer);
            if (ids.length > 0) {
                const documents = await Promise.all(
                    ids.map(
                        (id) =>
                            project?.documents?.find(
                                (document) => document.id === id,
                            ) ?? getDocument(id),
                    ),
                );
                documents.forEach(handleDocClick);
            } else if (isExternalFileDrag(event.dataTransfer)) {
                const entries = await collectDroppedDocumentUploadEntries(
                    event.dataTransfer,
                );
                await uploadEntries(entries, true);
            }
        } catch (error) {
            setDocumentDropError(
                userFacingApiError(
                    error,
                    "These files could not be opened. Please try again.",
                ),
            );
        }
    };

    // ── Folder handlers ───────────────────────────────────────────────────────
    const handleCreateFolder = async (
        parentId: string | null,
        name: string,
    ) => {
        const folder = await createProjectFolder(
            projectId,
            name,
            parentId ?? undefined,
        );
        setProject((prev) =>
            prev
                ? { ...prev, folders: [...(prev.folders ?? []), folder] }
                : prev,
        );
    };

    const handleRenameFolder = async (folderId: string, name: string) => {
        await renameProjectFolder(projectId, folderId, name);
        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      folders: (prev.folders ?? []).map((f) =>
                          f.id === folderId ? { ...f, name } : f,
                      ),
                  }
                : prev,
        );
    };

    const handleRenameDoc = async (docId: string, filename: string) => {
        const updated = await renameProjectDocument(projectId, docId, filename);
        setProject((current) =>
            current
                ? {
                      ...current,
                      documents: (current.documents ?? []).map((document) =>
                          document.id === docId
                              ? { ...document, ...updated }
                              : document,
                      ),
                  }
                : current,
        );
        setTabs((current) =>
            current.map((tab) =>
                tab.documentId === docId
                    ? { ...tab, filename: updated.filename }
                    : tab,
            ),
        );
    };

    const folderDeleteImpact = useCallback(
        (folderId: string) => {
            const childrenByParent = new Map<string, string[]>();
            for (const folder of project?.folders ?? []) {
                if (!folder.parent_folder_id) continue;
                const children =
                    childrenByParent.get(folder.parent_folder_id) ?? [];
                children.push(folder.id);
                childrenByParent.set(folder.parent_folder_id, children);
            }

            const toDelete = new Set<string>();
            const stack = [folderId];
            while (stack.length > 0) {
                const id = stack.pop();
                if (!id || toDelete.has(id)) continue;
                toDelete.add(id);
                stack.push(...(childrenByParent.get(id) ?? []));
            }

            const folderIds = [...toDelete];
            const documentIds = (project?.documents ?? [])
                .filter((document) =>
                    document.folder_id
                        ? toDelete.has(document.folder_id)
                        : false,
                )
                .map((document) => document.id);
            return {
                folderIds,
                documentIds,
                documentCount: documentIds.length,
            };
        },
        [project?.documents, project?.folders],
    );

    const requestDeleteFolder = useCallback(
        async (folderId: string) => {
            const folder = (project?.folders ?? []).find(
                (candidate) => candidate.id === folderId,
            );
            if (!folder) return;

            const impact = folderDeleteImpact(folderId);
            clearFolderDeleteDismissTimer();
            dispatchFolderDeleteDialog({
                type: "request",
                pending: {
                    folder,
                    folderIds: impact.folderIds,
                    documentIds: impact.documentIds,
                    documentCount: impact.documentCount,
                },
            });
        },
        [clearFolderDeleteDismissTimer, folderDeleteImpact, project?.folders],
    );

    const confirmDeletePendingFolder = async () => {
        const pending = pendingDeleteFolder;
        if (!pending || pendingDeleteFolderStatus === "deleting") return;

        dispatchFolderDeleteDialog({
            type: "start",
            folderId: pending.folder.id,
        });

        const folderIds = new Set(pending.folderIds);
        const deletedDocumentIds = new Set(pending.documentIds);

        try {
            await deleteProjectFolder(projectId, pending.folder.id);
            setProject((currentProject) =>
                currentProject
                    ? {
                          ...currentProject,
                          folders: (currentProject.folders ?? []).filter(
                              (folder) => !folderIds.has(folder.id),
                          ),
                          documents: (currentProject.documents ?? []).filter(
                              (document) =>
                                  !deletedDocumentIds.has(document.id),
                          ),
                      }
                    : currentProject,
            );
            setTabs((currentTabs) =>
                removeDeletedDocumentTabs(currentTabs, deletedDocumentIds),
            );
            setActiveTabId((currentId) =>
                clearDeletedDocumentId(currentId, deletedDocumentIds),
            );
            setSelectedDocId((currentId) =>
                clearDeletedDocumentId(currentId, deletedDocumentIds),
            );
            setEditScrollTarget((currentTarget) =>
                clearDeletedDocumentTarget(currentTarget, deletedDocumentIds),
            );
            dispatchFolderDeleteDialog({
                type: "complete",
                folderId: pending.folder.id,
            });

            clearFolderDeleteDismissTimer();
            folderDeleteDismissTimerRef.current = window.setTimeout(() => {
                dispatchFolderDeleteDialog({
                    type: "dismiss-completed",
                    folderId: pending.folder.id,
                });
                folderDeleteDismissTimerRef.current = null;
            }, 650);
        } catch (error) {
            console.error("delete folder failed", error);
            dispatchFolderDeleteDialog({
                type: "failed",
                folderId: pending.folder.id,
            });
        }
    };

    const handleMoveDoc = async (
        docId: string,
        targetFolderId: string | null,
    ) => {
        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      documents: (prev.documents ?? []).map((d) =>
                          d.id === docId
                              ? { ...d, folder_id: targetFolderId }
                              : d,
                      ),
                  }
                : prev,
        );
        await moveDocumentToFolder(projectId, docId, targetFolderId);
    };

    const handleMoveFolder = async (
        folderId: string,
        targetFolderId: string | null,
    ) => {
        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      folders: (prev.folders ?? []).map((f) =>
                          f.id === folderId
                              ? { ...f, parent_folder_id: targetFolderId }
                              : f,
                      ),
                  }
                : prev,
        );
        await moveSubfolderToFolder(projectId, folderId, targetFolderId);
    };

    const handleDeleteDoc = async (docId: string) => {
        await deleteDocument(docId);
        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      documents: (prev.documents ?? []).filter(
                          (d) => d.id !== docId,
                      ),
                  }
                : prev,
        );
        setTabs((prev) => prev.filter((t) => t.documentId !== docId));
        if (activeTabId === docId) {
            setActiveTabId(null);
            setActiveQuotes(null);
            setSelectedDocId(null);
            setEditScrollTarget(null);
        }
    };

    // ── Resize handlers ───────────────────────────────────────────────────────
    const onExplorerDividerDrag = useCallback((dx: number) => {
        setPanelWidths((current) => {
            const requestedWidth = Math.max(
                EXPLORER_MIN,
                current.explorer + dx,
            );
            const workspaceWidth = workspaceRef.current?.clientWidth;
            if (!workspaceWidth) {
                return { ...current, explorer: requestedWidth };
            }

            const maximumWidth = Math.max(
                EXPLORER_MIN,
                workspaceWidth -
                    DOCUMENT_MIN -
                    PANEL_DIVIDERS_WIDTH -
                    current.chat,
            );
            return {
                ...current,
                explorer: Math.min(requestedWidth, maximumWidth),
            };
        });
    }, []);

    const onChatDividerDrag = useCallback(
        (dx: number) => {
            setPanelWidths((current) => {
                const requestedWidth = Math.max(CHAT_MIN, current.chat - dx);
                const workspaceWidth = workspaceRef.current?.clientWidth;
                if (!workspaceWidth) {
                    return { ...current, chat: requestedWidth };
                }

                const occupiedWidth = explorerCollapsed
                    ? COLLAPSED_EXPLORER_FOOTPRINT
                    : current.explorer + PANEL_DIVIDERS_WIDTH;
                const maximumWidth = Math.max(
                    CHAT_MIN,
                    workspaceWidth - DOCUMENT_MIN - occupiedWidth,
                );
                return {
                    ...current,
                    chat: Math.min(requestedWidth, maximumWidth),
                };
            });
        },
        [explorerCollapsed],
    );

    useEffect(() => {
        const workspace = workspaceRef.current;
        if (!workspace) return;

        const fitPanels = () => {
            if (workspace.clientWidth <= 0) return;
            setPanelWidths((current) => {
                if (!explorerCollapsed) {
                    return fitExpandedPanelWidths(
                        current,
                        workspace.clientWidth,
                    );
                }

                const maximumChatWidth = Math.max(
                    CHAT_MIN,
                    workspace.clientWidth -
                        DOCUMENT_MIN -
                        COLLAPSED_EXPLORER_FOOTPRINT,
                );
                if (current.chat <= maximumChatWidth) return current;
                return { ...current, chat: maximumChatWidth };
            });
        };

        fitPanels();
        if (typeof ResizeObserver === "undefined") {
            window.addEventListener("resize", fitPanels);
            return () => window.removeEventListener("resize", fitPanels);
        }

        const observer = new ResizeObserver(fitPanels);
        observer.observe(workspace);
        return () => observer.disconnect();
    }, [explorerCollapsed]);

    return (
        <div
            ref={workspaceRef}
            className="my-2 ml-2 mr-3 flex h-[calc(100dvh-1rem)] min-h-0 md:my-3 md:h-[calc(100dvh-1.5rem)]"
            onDragOver={(event) => {
                if (isExternalFileDrag(event.dataTransfer)) {
                    event.preventDefault();
                }
            }}
            onDrop={(event) => {
                if (isExternalFileDrag(event.dataTransfer)) {
                    event.preventDefault();
                }
            }}
        >
            {/* LEFT: Project Explorer */}
            {!explorerCollapsed && (
                <>
                    <div
                        style={{ width: explorerWidth }}
                        className={cn(
                            "flex shrink-0 flex-col overflow-hidden rounded-l-2xl rounded-r-lg",
                            LIQUID_GLASS_FLAT_CLASS,
                        )}
                        onDragOver={(e) => {
                            e.preventDefault();
                            // Only show the upload overlay for external file drags, not internal moves
                            if (
                                isExternalFileDrag(e.dataTransfer) &&
                                !isProjectItemDrag(e.dataTransfer)
                            )
                                setExplorerDragOver(true);
                        }}
                        onDragLeave={(e) => {
                            if (
                                !e.currentTarget.contains(
                                    e.relatedTarget as Node,
                                )
                            )
                                setExplorerDragOver(false);
                        }}
                        onDrop={handleExplorerFileDrop}
                    >
                        {/* Explorer header */}
                        <div className="flex h-12 shrink-0 items-center justify-between px-3">
                            <span className="text-xs text-gray-700">
                                Explorer
                            </span>
                            <div className="flex items-center gap-1">
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept={SUPPORTED_DOCUMENT_ACCEPT}
                                    multiple
                                    className="hidden"
                                    onChange={(event) => {
                                        const files = Array.from(
                                            event.target.files ?? [],
                                        );
                                        event.target.value = "";
                                        void uploadFiles(files);
                                    }}
                                />
                                <input
                                    ref={folderInputRef}
                                    type="file"
                                    accept={SUPPORTED_DOCUMENT_ACCEPT}
                                    multiple
                                    className="hidden"
                                    {...{
                                        webkitdirectory: "",
                                        directory: "",
                                    }}
                                    onChange={(event) => {
                                        const entries =
                                            documentUploadEntriesFromFiles(
                                                event.target.files ?? [],
                                            );
                                        event.target.value = "";
                                        void uploadEntries(entries);
                                    }}
                                />
                                <DocumentUploadMenu
                                    onSavedFiles={() =>
                                        setAddDocumentsOpen(true)
                                    }
                                    onUploadFiles={() =>
                                        fileInputRef.current?.click()
                                    }
                                    onUploadFolder={() =>
                                        folderInputRef.current?.click()
                                    }
                                    disabled={!canEditContent}
                                />
                                <HeaderActionsMenu
                                    title="Explorer actions"
                                    triggerClassName="h-6 w-6 text-gray-500 hover:text-gray-900"
                                    items={[
                                        {
                                            label: "Select project",
                                            icon: FolderOpen,
                                            onSelect: () =>
                                                void projectPicker.openPicker(),
                                        },
                                        {
                                            label: "New subfolder",
                                            icon: FolderPlus,
                                            onSelect: () =>
                                                projectExplorerRef.current?.createRootFolder(),
                                            disabled: !canEditContent,
                                        },
                                        {
                                            label: "Go to project page",
                                            icon: ArrowUpRight,
                                            onSelect: () =>
                                                router.push(
                                                    `/projects/${projectId}`,
                                                ),
                                        },
                                    ]}
                                />
                                <button
                                    onClick={() => setExplorerCollapsed(true)}
                                    title="Collapse explorer"
                                    className="rounded p-1 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900"
                                >
                                    <ChevronLeft className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        </div>

                        {/* Drop overlay */}
                        <div
                            className={cn(
                                "relative h-full flex-1 overflow-y-auto rounded-bl-2xl rounded-br-lg",
                                explorerDragOver &&
                                    "bg-blue-50 ring-2 ring-inset ring-blue-400",
                            )}
                            onDragOver={(e) => {
                                e.preventDefault();
                            }}
                            onDrop={async (e) => {
                                e.preventDefault();
                                const docId = e.dataTransfer.getData(
                                    "application/mike-doc",
                                );
                                const folderId = e.dataTransfer.getData(
                                    "application/mike-folder",
                                );
                                if (docId) {
                                    e.stopPropagation();
                                    await handleMoveDoc(docId, null);
                                } else if (folderId) {
                                    e.stopPropagation();
                                    await handleMoveFolder(folderId, null);
                                }
                                // External file drops are not stopped — they bubble to handleExplorerFileDrop
                            }}
                        >
                            {explorerDragOver && (
                                <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                                    <p className="text-xs text-blue-500 font-medium">
                                        Drop to upload
                                    </p>
                                </div>
                            )}
                            <ProjectExplorer
                                ref={projectExplorerRef}
                                projectName={project?.name}
                                documents={project?.documents ?? []}
                                folders={project?.folders ?? []}
                                selectedDocId={selectedDocId}
                                onDocClick={handleDocClick}
                                onDownloadDoc={explorerDownload.downloadDocument}
                                onDownloadFolder={explorerDownload.downloadFolder}
                                downloading={explorerDownload.downloading}
                                onAddToChat={(document) =>
                                    chatInputRef.current?.addDoc(document)
                                }
                                addToChatDisabled={!canSendChat}
                                onCreateFolder={
                                    canEditContent
                                        ? handleCreateFolder
                                        : undefined
                                }
                                onRenameFolder={handleRenameFolder}
                                onRenameDoc={handleRenameDoc}
                                onDeleteFolder={requestDeleteFolder}
                                onDeleteDoc={handleDeleteDoc}
                                onMoveDoc={handleMoveDoc}
                                onMoveFolder={handleMoveFolder}
                                uploadingDocuments={uploadingDocuments}
                            />
                        </div>
                    </div>
                    <Divider onDrag={onExplorerDividerDrag} />
                </>
            )}

            {/* Collapsed explorer toggle */}
            {explorerCollapsed && (
                <div
                    className={cn(
                        "flex shrink-0 flex-col overflow-hidden rounded-l-2xl rounded-r-lg",
                        LIQUID_GLASS_FLAT_CLASS,
                    )}
                >
                    <div className="flex h-12 shrink-0 items-center justify-center px-1">
                        <button
                            onClick={() => setExplorerCollapsed(false)}
                            title="Expand explorer"
                            className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                        >
                            <ChevronRight className="h-3.5 w-3.5" />
                        </button>
                    </div>
                </div>
            )}
            {explorerCollapsed && (
                <div className="w-1.5 shrink-0" aria-hidden="true" />
            )}

            {/* CENTER: Document Panel */}
            <div
                role="region"
                aria-label="Document viewer"
                style={{ minWidth: DOCUMENT_MIN }}
                className={cn(
                    "relative flex flex-1 flex-col overflow-hidden rounded-lg",
                    LIQUID_GLASS_FLAT_CLASS,
                )}
                onDragOverCapture={(event) => {
                    if (!isDocumentViewerDrag(event.dataTransfer)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = "copy";
                    setDocumentDragOver(true);
                }}
                onDragLeave={(event) => {
                    if (
                        !event.currentTarget.contains(
                            event.relatedTarget as Node,
                        )
                    ) {
                        setDocumentDragOver(false);
                    }
                }}
                onDropCapture={handleDocumentDrop}
            >
                {documentDragOver && (
                    <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-lg bg-white/50 backdrop-blur-md">
                        <p className="font-serif text-xl text-gray-900">
                            Drop files here to open
                        </p>
                    </div>
                )}
                <ProjectDocumentTabs
                    tabs={tabs}
                    documents={project?.documents ?? []}
                    activeTabId={activeTabId}
                    onActivate={switchTab}
                    onClose={closeTab}
                    onReorder={(draggedId, targetId, position) =>
                        setTabs((current) =>
                            reorderTabs(
                                current,
                                draggedId,
                                targetId,
                                position,
                                (tab) => tab.documentId,
                            ),
                        )
                    }
                />
                <ProjectDocumentPanels
                    tabs={tabs}
                    documents={project?.documents ?? []}
                    activeTabId={activeTabId}
                    quotes={activeQuotes ?? undefined}
                    highlightEdit={editScrollTarget}
                    onWarningDismiss={dismissTabWarning}
                />
            </div>

            <Divider onDrag={onChatDividerDrag} />

            {/* RIGHT: Assistant Panel */}
            <div
                style={{ width: chatWidth }}
                className={cn(
                    "relative flex shrink-0 flex-col overflow-hidden rounded-l-lg rounded-r-2xl",
                    LIQUID_GLASS_FLAT_CLASS,
                )}
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
                    <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-l-lg rounded-r-2xl bg-white/50 backdrop-blur-md">
                        <p className="font-serif text-xl text-gray-900">
                            Drop files here to add to chat
                        </p>
                    </div>
                )}
                <div className="absolute inset-x-0 top-0 z-40">
                    <ChatPanelHeader
                        chats={availableProjectChats}
                        currentChatId={activeChatId}
                        currentTitle={chatTitle}
                        loading={projectChats === null}
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
                                    if (editingChatTitle) event.preventDefault();
                                }}
                                items={[
                                    {
                                        label: "Rename",
                                        icon: Pencil,
                                        onSelect: () => void handleRenameChat(),
                                        disabled: !chatLoaded || !activeChatId,
                                    },
                                    {
                                        label: "Memory",
                                        icon: Brain,
                                        onSelect: () =>
                                            setProjectMemoryOpen(true),
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
                                            !activeChatId,
                                        variant: "danger" as const,
                                    },
                                ].filter((item) =>
                                    activeChatId ? true : item.label === "Memory",
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
                                                handleOpenDocument({
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
                                        isError={!!msg.error}
                                        citations={msg.citations}
                                        citationStatus={msg.citationStatus}
                                        onCitationClick={handleCitationClick}
                                        minHeight={
                                            i === lastAssistantIdx
                                                ? minHeight
                                                : "0px"
                                        }
                                        onEditViewClick={handleEditViewClick}
                                        onOpenDocument={handleOpenDocument}
                                        onEditError={handleEditError}
                                        onEditResolved={handleEditResolved}
                                    />
                                ),
                            );
                        })()}
                    </div>
                )}

                {/* ChatInput */}
                <div className="absolute bottom-3 left-3 right-3 z-30">
                    <div className="pointer-events-none absolute -bottom-3 inset-x-0 z-0 h-7 bg-app-surface" />
                    <div className="relative z-20 w-full">
                        <ChatInputPrompt
                            messages={messages}
                            chatKey={activeChatId}
                            canSend={canSendChat && chatLoaded}
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
                                enableGlobalFileDrop={false}
                                dropUploadsToProject={false}
                                projectId={projectId}
                                onDocumentClick={handleDocClick}
                                projectName={project?.name}
                                projectCmNumber={project?.cm_number}
                            />
                        </ChatInputPrompt>
                    </div>
                </div>
            </div>
            {project && (
                <AddDocumentsModal
                    open={addDocumentsOpen}
                    onClose={() => setAddDocumentsOpen(false)}
                    onSelect={(documents) => addUploadedDocuments(documents)}
                    breadcrumb={[
                        "Projects",
                        project.name +
                            (project.cm_number
                                ? ` (${project.cm_number})`
                                : ""),
                        "Add Documents",
                    ]}
                    projectId={projectId}
                    uploadStateId={`project-chat:${projectId}`}
                />
            )}
            <WarningPopup
                open={!!projectPicker.error}
                onClose={projectPicker.clearError}
                title="Projects could not be loaded"
                message={projectPicker.error ?? ""}
            />
            <WarningPopup
                open={!!documentDropError}
                onClose={() => setDocumentDropError(null)}
                title="Files could not be opened"
                message={documentDropError ?? ""}
            />
            <ProjectPickerModal
                open={projectPicker.open}
                onClose={projectPicker.closePicker}
                projects={projectPicker.projects ?? []}
                loading={projectPicker.loading}
                selectedId={projectPicker.selectedId}
                onSelect={projectPicker.setSelectedId}
                breadcrumbs={["IDE", "Select project"]}
                primaryAction={{
                    label: "Select project",
                    type: "button",
                    onClick: selectProject,
                    disabled: !projectPicker.selectedId,
                }}
            />
            <ProjectMemoryModal
                key={projectId}
                open={projectMemoryOpen}
                onClose={() => setProjectMemoryOpen(false)}
                projectId={projectId}
                projectName={project?.name ?? null}
                projectLoading={!project}
                canEdit={canEditContent}
                canManage={canManageProject}
                onMemoryEnabledChange={(enabled) =>
                    setProject((current) =>
                        current
                            ? { ...current, memory_enabled: enabled }
                            : current,
                    )
                }
            />
            <WarningPopup
                open={!!explorerDownload.error}
                title="Download failed"
                message={explorerDownload.error}
                onClose={explorerDownload.clearError}
            />
            <PermissionDeniedPopup
                open={!!ownerOnlyAction}
                action={ownerOnlyAction ?? undefined}
                contacts={project?.admin_contacts}
                onClose={() => setOwnerOnlyAction(null)}
            />
            <PermissionDeniedPopup
                open={!!editorGateAction}
                action={editorGateAction ?? undefined}
                requiredRole="editor"
                contacts={project?.admin_contacts}
                onClose={() => setEditorGateAction(null)}
            />
            <ConfirmPopup
                open={!!pendingDeleteFolder}
                title="Delete folder?"
                message={
                    pendingDeleteFolder ? (
                        <div className="space-y-2">
                            <p>
                                This will permanently delete{" "}
                                <span className="font-medium text-gray-950">
                                    {pendingDeleteFolder.folderIds.length}{" "}
                                    {pendingDeleteFolder.folderIds.length === 1
                                        ? "folder"
                                        : "folders"}
                                </span>
                                , including{" "}
                                <span className="font-medium text-gray-950">
                                    {pendingDeleteFolder.folder.name}
                                </span>
                                {pendingDeleteFolder.folderIds.length > 1
                                    ? " and its nested subfolders"
                                    : ""}
                                .
                            </p>
                            {pendingDeleteFolder.documentCount > 0 && (
                                <p>
                                    {pendingDeleteFolder.documentCount}{" "}
                                    {pendingDeleteFolder.documentCount === 1
                                        ? "document"
                                        : "documents"}{" "}
                                    in the deleted{" "}
                                    {pendingDeleteFolder.folderIds.length === 1
                                        ? "folder"
                                        : "folders"}{" "}
                                    will also be permanently deleted.
                                </p>
                            )}
                        </div>
                    ) : undefined
                }
                confirmLabel="Delete"
                confirmVariant="danger"
                confirmStatus={
                    pendingDeleteFolderStatus === "deleting"
                        ? "loading"
                        : pendingDeleteFolderStatus === "deleted"
                          ? "complete"
                          : "idle"
                }
                cancelLabel="Cancel"
                onCancel={() => {
                    if (pendingDeleteFolderStatus === "deleting") return;
                    clearFolderDeleteDismissTimer();
                    dispatchFolderDeleteDialog({ type: "cancel" });
                }}
                onConfirm={() => void confirmDeletePendingFolder()}
            />
        </div>
    );
}
