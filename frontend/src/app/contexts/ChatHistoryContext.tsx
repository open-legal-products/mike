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
    createChat,
    deleteChat,
    listChats,
    renameChat,
} from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import type { Chat, Message } from "@/app/components/shared/types";

interface ChatHistoryContextType {
    chats: Chat[] | null;
    hasMoreChats: boolean;
  loadingMoreChats: boolean;
    currentChatId: string | null;
    setCurrentChatId: (chatId: string | null) => void;
    loadChats: () => Promise<void>;
  loadMoreChats: () => Promise<void>;
    saveChat: (
        projectId?: string,
        options?: { onRetry?: () => void | Promise<void> },
    ) => Promise<string | null>;
    renameChat: (chatId: string, title: string) => Promise<void>;
    updateChatTitle: (chatId: string, title: string) => void;
    newChatMessages: Message[] | null;
    setNewChatMessages: (messages: Message[] | null) => void;
  replaceChatId: (oldChatId: string, newChatId: string, title?: string) => void;
    deleteChat: (chatId: string) => Promise<void>;
}

const ChatHistoryContext = createContext<ChatHistoryContextType | undefined>(
    undefined,
);

const INITIAL_CHAT_LIMIT = 20;
const CHAT_PAGE_SIZE = 10;

export function ChatHistoryProvider({ children }: { children: ReactNode }) {
    const { user } = useAuth();
    const [chats, setChats] = useState<Chat[] | null>(null);
    const [hasMoreChats, setHasMoreChats] = useState(false);
  const [loadingMoreChats, setLoadingMoreChats] = useState(false);
  const loadingMoreChatsRef = useRef(false);
    const [currentChatId, setCurrentChatId] = useState<string | null>(null);
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

        try {
      const data = await listChats({ limit: INITIAL_CHAT_LIMIT + 1 });
      setChats(data.slice(0, INITIAL_CHAT_LIMIT));
      setHasMoreChats(data.length > INITIAL_CHAT_LIMIT);
        } catch (error) {
            setChats([]);
            setHasMoreChats(false);
            // An empty sidebar is how "you have no chats" looks, so a failed
            // load has to say that it failed.
            notifyError(error, {
                action: "load your chats",
                dedupeKey: "chat-history",
                onRetry: () => retryRef.current.loadChats(),
            });
        }
  }, [user]);

    useEffect(() => {
        if (!user) {
            setChats([]);
            setHasMoreChats(false);
      setLoadingMoreChats(false);
      loadingMoreChatsRef.current = false;
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
      const data = await listChats({
        limit: CHAT_PAGE_SIZE + 1,
        offset: chats.length,
      });
      const page = data.slice(0, CHAT_PAGE_SIZE);
      setChats((current) => {
        const existing = new Set((current ?? []).map((chat) => chat.id));
        return [
          ...(current ?? []),
          ...page.filter((chat) => !existing.has(chat.id)),
        ];
      });
      setHasMoreChats(data.length > CHAT_PAGE_SIZE);
    } catch (error) {
      // The current page is preserved; the user is told the next one is
      // missing rather than being left to scroll at a list that stopped
      // growing.
      notifyError(error, {
        action: "load more chats",
        dedupeKey: "chat-history-more",
        onRetry: () => retryRef.current.loadMoreChats(),
      });
    } finally {
      loadingMoreChatsRef.current = false;
      setLoadingMoreChats(false);
    }
  }, [chats, hasMoreChats, user]);

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
            options?: { onRetry?: () => void | Promise<void> },
        ): Promise<string | null> => {
            try {
                const { id } = await createChat(
                    projectId ? { project_id: projectId } : undefined,
                );
                const now = new Date().toISOString();
                const newChat: Chat = {
                    id,
                    project_id: projectId ?? null,
                    user_id: user?.id ?? "",
                    title: null,
                    created_at: now,
                    // The optimistic row must say what the server would say.
                    // The overview RPC serves is_owner + access_role on every
                    // row, and the sidebar's gates read them via roleFrom(),
                    // which fails closed to viewer when both are absent — so
                    // without this stamp the creator was refused rename and
                    // delete on their own brand-new thread until a reload.
                    // The caller IS the creator here, and a chat's creator
                    // derives admin standing on their row by definition.
                    is_owner: true,
                    access_role: "owner",
                };
                setChats((prev) => [newChat, ...(prev ?? [])]);
                return id;
            } catch (error) {
                // Callers only see `null`, and the ones that do simply stop —
                // so this is the last place that can tell the user their
                // chat was never created. Retry is only offered when the
                // caller can re-run its whole submit (create + send), since
                // repeating the create alone would strand an empty chat.
                notifyError(error, {
                    action: "start a new chat",
                    onRetry: options?.onRetry,
                });
                return null;
            }
        },
        [user],
    );

    const renameChatFn = useCallback(
        async (chatId: string, title: string) => {
            setChats((prev) =>
        (prev ?? []).map((c) => (c.id === chatId ? { ...c, title } : c)),
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
            (prev ?? []).map((chat) =>
                chat.id === chatId ? { ...chat, title } : chat,
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
