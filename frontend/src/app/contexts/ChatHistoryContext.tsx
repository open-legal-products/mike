"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { useAuth } from "@/app/contexts/AuthContext";
import {
    useWorkspaceOrgId,
    useWorkspaceParam,
} from "@/app/contexts/WorkspaceContext";
import {
    createChat,
    deleteChat,
    listChats,
    renameChat,
} from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import type { Chat, Message } from "@/app/components/shared/types";
import type { ProjectRole } from "@/app/lib/permissions";
import { subscribeAssistantTurns } from "@/app/lib/assistantTurns";
import { sortChatsByActivity, touchChatActivity } from "@/app/lib/chatActivity";

interface ChatHistoryContextType {
    chats: Chat[] | null;
    hasMoreChats: boolean;
  loadingMoreChats: boolean;
    currentChatId: string | null;
    setCurrentChatId: (chatId: string | null) => void;
    /** The chat shown beside the current one, if a page shows two. */
    sideChatId: string | null;
    setSideChatId: (chatId: string | null) => void;
    /**
     * A chat the app shell asked the page on screen to show beside its
     * current one. The page opens it and clears the request.
     */
    sideChatRequest: string | null;
    requestSideChat: (chatId: string | null) => void;
    loadChats: () => Promise<void>;
  loadMoreChats: () => Promise<void>;
    saveChat: (
        projectId?: string,
        projectRole?: ProjectRole | null,
    ) => Promise<string | null>;
    renameChat: (chatId: string, title: string) => Promise<void>;
    updateChatTitle: (chatId: string, title: string) => void;
    newChatMessages: Message[] | null;
    setNewChatMessages: (messages: Message[] | null) => void;
    replaceChatId: (
        oldChatId: string,
        newChatId: string,
        title?: string,
    ) => void;
    deleteChat: (chatId: string) => Promise<void>;
}

const ChatHistoryContext = createContext<ChatHistoryContextType | undefined>(
    undefined,
);

const INITIAL_CHAT_LIMIT = 20;
const CHAT_PAGE_SIZE = 10;

type ChatCursor = { updatedAt: string; id: string };

function cursorFor(chat: Chat | undefined): ChatCursor | null {
    const updatedAt = chat?.updated_at || chat?.created_at;
    return chat && updatedAt ? { updatedAt, id: chat.id } : null;
}

export function ChatHistoryProvider({ children }: { children: ReactNode }) {
    const { user } = useAuth();
    // The sidebar history follows the active workspace: switching re-reads
    // the first page, through loadChats's identity changing below.
    const workspace = useWorkspaceParam();
    const workspaceOrgId = useWorkspaceOrgId();
    const [chats, setChats] = useState<Chat[] | null>(null);
    const [hasMoreChats, setHasMoreChats] = useState(false);
    const [loadingMoreChats, setLoadingMoreChats] = useState(false);
    const loadingMoreChatsRef = useRef(false);
    const nextChatCursorRef = useRef<ChatCursor | null>(null);
    // Which first-page read is current, and which workspace the list on
    // screen came from. A switch must not leave the previous workspace's
    // history showing, and its slower answer must not land on top of the new
    // one.
    const chatsRequestRef = useRef(0);
    const loadedWorkspaceRef = useRef<string | undefined>(undefined);
    const [currentChatId, setCurrentChatId] = useState<string | null>(null);
    const [sideChatId, setSideChatId] = useState<string | null>(null);
    const [sideChatRequest, requestSideChat] = useState<string | null>(null);
    const [newChatMessages, setNewChatMessages] = useState<Message[] | null>(
        null,
    );
    // "Retry" re-enters the latest loader: a callback cannot reference
    // itself, and these are re-created as the chat list changes.
    const retryRef = useRef<{
        loadChats: () => void;
        loadMoreChats: () => void;
    }>({ loadChats: () => {}, loadMoreChats: () => {} });

    const loadChats = useCallback(async () => {
        if (!user) {
            setChats([]);
            setHasMoreChats(false);
            return;
        }

        const request = ++chatsRequestRef.current;
        if (loadedWorkspaceRef.current !== workspace) {
            loadedWorkspaceRef.current = workspace;
            setChats(null);
            setHasMoreChats(false);
            nextChatCursorRef.current = null;
        }
        try {
            const data = await listChats({
                limit: INITIAL_CHAT_LIMIT + 1,
                workspace,
            });
            if (request !== chatsRequestRef.current) return;
            const page = data.slice(0, INITIAL_CHAT_LIMIT);
            setChats(sortChatsByActivity(page));
            nextChatCursorRef.current = cursorFor(page.at(-1));
            setHasMoreChats(data.length > INITIAL_CHAT_LIMIT);
        } catch (error) {
            if (request !== chatsRequestRef.current) return;
            setChats([]);
            nextChatCursorRef.current = null;
            setHasMoreChats(false);
            // An empty sidebar is how "you have no chats" looks, so a failed
            // load has to say that it failed.
            notifyError(error, {
                action: "load your chats",
                dedupeKey: "chat-history",
                onRetry: () => retryRef.current.loadChats(),
            });
        }
    }, [user, workspace]);

    useEffect(() => {
        if (!user) {
            setChats([]);
            setHasMoreChats(false);
            setLoadingMoreChats(false);
            loadingMoreChatsRef.current = false;
            nextChatCursorRef.current = null;
            setCurrentChatId(null);
            return;
        }

        void loadChats();
    }, [user, loadChats]);

    const loadMoreChats = useCallback(async () => {
        if (
            !user ||
            !hasMoreChats ||
            loadingMoreChatsRef.current ||
            chats === null
        ) {
            return;
        }

        loadingMoreChatsRef.current = true;
        setLoadingMoreChats(true);
        try {
            const cursor = nextChatCursorRef.current;
            if (!cursor) {
                setHasMoreChats(false);
                return;
            }
            const data = await listChats({
                limit: CHAT_PAGE_SIZE + 1,
                beforeUpdatedAt: cursor.updatedAt,
                beforeId: cursor.id,
                workspace,
            });
            // The workspace changed while this page was in flight: it
            // belongs to a list that is no longer on screen.
            if (loadedWorkspaceRef.current !== workspace) return;
            const page = data.slice(0, CHAT_PAGE_SIZE);
            nextChatCursorRef.current = cursorFor(page.at(-1));
            setChats((current) => {
                const existing = new Set(
                    (current ?? []).map((chat) => chat.id),
                );
                return sortChatsByActivity([
                    ...(current ?? []),
                    ...page.filter((chat) => !existing.has(chat.id)),
                ]);
            });
            setHasMoreChats(data.length > CHAT_PAGE_SIZE);
        } catch (error) {
            // A page for a workspace no longer on screen failed: not news.
            if (loadedWorkspaceRef.current !== workspace) return;
            notifyError(error, {
                action: "load more chats",
                dedupeKey: "chat-history-more",
                onRetry: () => retryRef.current.loadMoreChats(),
            });
        } finally {
            loadingMoreChatsRef.current = false;
            setLoadingMoreChats(false);
        }
    }, [chats, hasMoreChats, user, workspace]);

    useEffect(
        () =>
            subscribeAssistantTurns((chatId) => {
                setChats((current) =>
                    current ? touchChatActivity(current, chatId) : current,
                );
            }),
        [],
    );

    useEffect(() => {
        retryRef.current = {
            loadChats: () => void loadChats(),
            loadMoreChats: () => void loadMoreChats(),
        };
    }, [loadChats, loadMoreChats]);

    const replaceChatId = useCallback(
        (oldChatId: string, newChatId: string, title?: string) => {
            if (!oldChatId || !newChatId || oldChatId === newChatId) {
                setCurrentChatId(newChatId || oldChatId || null);
                return;
            }

            setChats((prev) => {
                if (!prev) return prev;

                const nextChats = prev.map((chat) =>
                    chat.id === oldChatId
                        ? { ...chat, id: newChatId, title: title ?? chat.title }
                        : chat,
                );

                const seen = new Set<string>();
                return nextChats.filter((chat) => {
                    if (seen.has(chat.id)) return false;
                    seen.add(chat.id);
                    return true;
                });
            });
            setCurrentChatId(newChatId);
        },
        [],
    );

    const saveChat = useCallback(
        async (
            projectId?: string,
            projectRole?: ProjectRole | null,
        ): Promise<string | null> => {
            try {
                // A chat started on its own belongs to the workspace it is
                // started in; inside a project, the project decides.
                const { id } = await createChat(
                    projectId
                        ? { project_id: projectId }
                        : workspaceOrgId
                          ? { org_id: workspaceOrgId }
                          : undefined,
                );
                const now = new Date().toISOString();
                // The optimistic row must say what the server would say.
                // The overview RPC serves is_owner + access_role on every
                // row, and the sidebar's gates read them via roleFrom(),
                // which fails closed to viewer when both are absent — so
                // without a stamp the creator was refused rename and delete
                // on their own brand-new thread until a reload.
                //
                // What the stamp should SAY differs by chat kind. A
                // standalone chat belongs to its creator, so owner is what
                // the server serves back. A PROJECT chat does not: the
                // server derives its role from the caller's role on the
                // project (ensureSharedRowAccess), so an editor who starts a
                // thread there is an editor on it. Stamping owner offered
                // that editor a Delete which came back 403 — the sidebar
                // promised something the server refuses. Callers pass their
                // project role; absent one we fall back to editor, the
                // minimum the server requires to have created the chat at
                // all, rather than to the top of the ladder.
                const role: ProjectRole = projectId
                    ? (projectRole ?? "editor")
                    : "owner";
                const newChat: Chat = {
                    id,
                    project_id: projectId ?? null,
                    user_id: user?.id ?? "",
                    title: null,
                    created_at: now,
                    updated_at: now,
                    is_owner: role === "owner",
                    access_role: role,
                };
                setChats((prev) =>
                    sortChatsByActivity([newChat, ...(prev ?? [])]),
                );
                return id;
            } catch (error) {
                // Callers only see `null`, and the ones that do simply stop —
                // so this is the last place that can tell the user their
                // chat was never created. No Retry: repeating the create
                // alone would strand an empty chat, and no caller re-runs
                // its whole submit (create + send) from here.
                notifyError(error, { action: "start a new chat" });
                return null;
            }
        },
        [user, workspaceOrgId],
    );

    const renameChatFn = useCallback(
        async (chatId: string, title: string) => {
            setChats((prev) =>
                touchChatActivity(
                    (prev ?? []).map((c) =>
                        c.id === chatId ? { ...c, title } : c,
                    ),
                    chatId,
                ),
            );
            try {
                await renameChat(chatId, title);
            } catch (error) {
                // Same contract as delete below: the optimistic write must
                // not become a silent success. The old bare catch let a
                // refused rename show the new title and then quietly revert
                // it on reload — the caller rethrows so the row's UI can say
                // why the title snapped back.
                void loadChats();
                throw error;
            }
        },
        [loadChats],
    );

    const updateChatTitle = useCallback((chatId: string, title: string) => {
        setChats((prev) =>
            touchChatActivity(
                (prev ?? []).map((chat) =>
                    chat.id === chatId ? { ...chat, title } : chat,
                ),
                chatId,
            ),
        );
    }, []);

    const deleteChatFn = useCallback(
        async (chatId: string) => {
            setChats((prev) => (prev ?? []).filter((c) => c.id !== chatId));
            if (currentChatId === chatId) setCurrentChatId(null);
            try {
                await deleteChat(chatId);
            } catch (error) {
                // Optimistic removal must not become a silent success: put
                // the row back and let the caller tell the user why. The old
                // bare catch here was the client-side twin of the
                // filter-scoped 204 this stack removes on the server.
                void loadChats();
                throw error;
            }
        },
        [currentChatId, loadChats],
    );

    const value = useMemo(
        () => ({
            chats,
            hasMoreChats,
      loadingMoreChats,
            currentChatId,
            setCurrentChatId,
            sideChatId,
            setSideChatId,
            sideChatRequest,
            requestSideChat,
            loadChats,
            loadMoreChats,
            saveChat,
            renameChat: renameChatFn,
            updateChatTitle,
            newChatMessages,
            setNewChatMessages,
            replaceChatId,
            deleteChat: deleteChatFn,
        }),
        [
            chats,
            hasMoreChats,
      loadingMoreChats,
            currentChatId,
            sideChatId,
            sideChatRequest,
            loadChats,
            loadMoreChats,
            saveChat,
            renameChatFn,
            updateChatTitle,
            newChatMessages,
            replaceChatId,
            deleteChatFn,
        ],
    );

    return (
        <ChatHistoryContext.Provider value={value}>
            {children}
        </ChatHistoryContext.Provider>
    );
}

export function useChatHistoryContext() {
    const context = useContext(ChatHistoryContext);
    if (!context) {
        throw new Error(
            "useChatHistoryContext must be used within a ChatHistoryProvider",
        );
    }
    return context;
}
