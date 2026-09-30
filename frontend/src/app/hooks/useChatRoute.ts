"use client";

import { useCallback, useRef, useState } from "react";
import { usePathname } from "next/navigation";

function chatIdFromPath(pathname: string, chatPath: string): string {
    const prefix = `${chatPath}/`;
    if (!pathname.startsWith(prefix)) return "";
    const segment = pathname.slice(prefix.length).split("/")[0] ?? "";
    return decodeURIComponent(segment);
}

/**
 * The chat a page shows, kept in the URL without navigating.
 *
 * The new-chat URL and `<chatPath>/:id` render the same page. Opening a chat
 * rewrites the URL with `history.pushState` instead of routing, so the page
 * stays mounted: an answer streaming in, the composer, and the panels survive
 * the switch. Real navigations — a sidebar link, back/forward — still move
 * the chat, because the pathname is re-read whenever it changes.
 */
export function useChatRoute(chatPath: string, newChatPath: string = chatPath) {
    const pathname = usePathname() ?? "";
    const [chatId, setChatId] = useState(() =>
        chatIdFromPath(pathname, chatPath),
    );
    const [seenPathname, setSeenPathname] = useState(pathname);
    if (pathname !== seenPathname) {
        setSeenPathname(pathname);
        setChatId(chatIdFromPath(pathname, chatPath));
    }
    const createdRef = useRef<string | null>(null);

    /** Show `id`, or the new-chat view for `""`. */
    const openChat = useCallback(
        (id: string) => {
            setChatId(id);
            const href = id
                ? `${chatPath}/${encodeURIComponent(id)}`
                : newChatPath;
            if (window.location.pathname !== href) {
                window.history.pushState(null, "", href);
            }
        },
        [chatPath, newChatPath],
    );

    /** Open the chat the server just created for the answer on screen. */
    const adoptChat = useCallback(
        (id: string) => {
            createdRef.current = id;
            openChat(id);
        },
        [openChat],
    );

    /**
     * True once for the chat `adoptChat` opened. Its messages are already on
     * screen, so the page must not clear and reload them.
     */
    const claimCreated = useCallback((id: string) => {
        if (!id || createdRef.current !== id) return false;
        createdRef.current = null;
        return true;
    }, []);

    return { chatId, openChat, adoptChat, claimCreated };
}
