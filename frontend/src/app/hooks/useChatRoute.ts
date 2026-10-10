"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

const SIDE_CHAT_PARAM = "side";
const NEW_SIDE_CHAT = "new";

function chatIdFromPath(pathname: string, chatPath: string): string {
    const prefix = `${chatPath}/`;
    if (!pathname.startsWith(prefix)) return "";
    const segment = pathname.slice(prefix.length).split("/")[0] ?? "";
    try {
        return decodeURIComponent(segment);
    } catch {
        return "";
    }
}

/** `null` when no side chat is open, `""` for a new one, else its id. */
function sideChatIdFromSearch(search: string): string | null {
    const value = new URLSearchParams(search).get(SIDE_CHAT_PARAM);
    if (!value) return null;
    return value === NEW_SIDE_CHAT ? "" : value;
}

function searchWithSideChat(search: string, sideChatId: string | null): string {
    const params = new URLSearchParams(search);
    if (sideChatId === null) params.delete(SIDE_CHAT_PARAM);
    else params.set(SIDE_CHAT_PARAM, sideChatId || NEW_SIDE_CHAT);
    const serialized = params.toString();
    return serialized ? `?${serialized}` : "";
}

/**
 * The chats a page shows, kept in the URL without navigating.
 *
 * The new-chat URL and `<chatPath>/:id` render the same page. Opening a chat
 * rewrites the URL with `history.pushState` instead of routing, so the page
 * stays mounted: an answer streaming in, the composer, and the panels survive
 * the switch. Real navigations — a sidebar link, back/forward — still move
 * the chat, because the pathname is re-read whenever it changes.
 *
 * A second chat can be shown beside the first. It lives in the `side` query
 * parameter, so the path keeps naming the primary chat and a reload or a
 * shared link restores both. A sidebar link names only the primary chat; the
 * side chat stays open across it, while back/forward follow the URL.
 */
export function useChatRoute(chatPath: string, newChatPath: string = chatPath) {
    const pathname = usePathname() ?? "";
    const [chatId, setChatId] = useState(() =>
        chatIdFromPath(pathname, chatPath),
    );
    // Not read from the URL until after hydration: the server never sees the
    // query, and `ready` keeps the URL from being rewritten before it is read.
    const [side, setSide] = useState<{ ready: boolean; id: string | null }>({
        ready: false,
        id: null,
    });
    const [seenPathname, setSeenPathname] = useState(pathname);
    if (pathname !== seenPathname) {
        const nextChatId = chatIdFromPath(pathname, chatPath);
        setSeenPathname(pathname);
        setChatId(nextChatId);
        // One chat is never shown twice.
        if (nextChatId && nextChatId === side.id) {
            setSide({ ready: true, id: null });
        }
    }
    const [seenChatPath, setSeenChatPath] = useState(chatPath);
    if (chatPath !== seenChatPath) {
        setSeenChatPath(chatPath);
        setSide({ ready: true, id: null });
    }
    const sideChatId = side.id;
    const createdRef = useRef(new Set<string>());

    useEffect(() => {
        const readSideChat = () =>
            setSide({
                ready: true,
                id: sideChatIdFromSearch(window.location.search),
            });
        readSideChat();
        window.addEventListener("popstate", readSideChat);
        return () => window.removeEventListener("popstate", readSideChat);
    }, []);

    // A real navigation lands on a URL without the side chat; put it back.
    useEffect(() => {
        if (!side.ready) return;
        const search = searchWithSideChat(window.location.search, side.id);
        if (search === window.location.search) return;
        window.history.replaceState(
            null,
            "",
            `${window.location.pathname}${search}${window.location.hash}`,
        );
    }, [pathname, side]);

    const pushRoute = useCallback(
        (id: string, nextSideChatId: string | null) => {
            const path = id
                ? `${chatPath}/${encodeURIComponent(id)}`
                : newChatPath;
            const search = searchWithSideChat(
                window.location.search,
                nextSideChatId,
            );
            if (
                window.location.pathname !== path ||
                window.location.search !== search
            ) {
                window.history.pushState(null, "", `${path}${search}`);
            }
        },
        [chatPath, newChatPath],
    );

    /** Show `id`, or the new-chat view for `""`. */
    const openChat = useCallback(
        (id: string) => {
            const nextSideChatId = id && id === sideChatId ? null : sideChatId;
            setChatId(id);
            if (nextSideChatId !== sideChatId) {
                setSide({ ready: true, id: nextSideChatId });
            }
            pushRoute(id, nextSideChatId);
        },
        [pushRoute, sideChatId],
    );

    /** Show `id` beside the primary chat, or a new chat for `""`. */
    const openSideChat = useCallback(
        (id: string) => {
            if (id && id === chatId) return;
            setSide({ ready: true, id });
            pushRoute(chatId, id);
        },
        [chatId, pushRoute],
    );

    const closeSideChat = useCallback(() => {
        setSide({ ready: true, id: null });
        pushRoute(chatId, null);
    }, [chatId, pushRoute]);

    /** Open the chat the server just created for the answer on screen. */
    const adoptChat = useCallback(
        (id: string) => {
            createdRef.current.add(id);
            openChat(id);
        },
        [openChat],
    );

    /** The same, for an answer in the side chat. */
    const adoptSideChat = useCallback(
        (id: string) => {
            createdRef.current.add(id);
            openSideChat(id);
        },
        [openSideChat],
    );

    /**
     * True once for a chat `adoptChat` or `adoptSideChat` opened. Its messages
     * are already on screen, so the page must not clear and reload them.
     */
    const claimCreated = useCallback(
        (id: string) => !!id && createdRef.current.delete(id),
        [],
    );

    return {
        chatId,
        openChat,
        adoptChat,
        claimCreated,
        sideChatId,
        openSideChat,
        adoptSideChat,
        closeSideChat,
    };
}
