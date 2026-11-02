import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/assistant" }));

vi.mock("next/navigation", () => ({
    usePathname: () => navigation.pathname,
}));

import { useChatRoute } from "./useChatRoute";

function renderChatRoute() {
    return renderHook(() => useChatRoute("/assistant/chat", "/assistant"));
}

describe("useChatRoute", () => {
    beforeEach(() => {
        navigation.pathname = "/assistant";
        window.history.replaceState(null, "", "/assistant");
    });

    it("reads the chat from the URL, and none from the new-chat URL", () => {
        expect(renderChatRoute().result.current.chatId).toBe("");

        navigation.pathname = "/assistant/chat/c1";
        expect(renderChatRoute().result.current.chatId).toBe("c1");
    });

    it("handles malformed escapes on initial load and navigation", () => {
        navigation.pathname = "/assistant/chat/%E0%A4%A";
        const { result, rerender } = renderChatRoute();
        expect(result.current.chatId).toBe("");
        navigation.pathname = "/assistant/chat/valid%20id";
        rerender();
        expect(result.current.chatId).toBe("valid id");
        navigation.pathname = "/assistant/chat/%ZZ";
        rerender();
        expect(result.current.chatId).toBe("");
    });

    it("opens a chat by rewriting the URL, without navigating", () => {
        const pushState = vi.spyOn(window.history, "pushState");
        const { result } = renderChatRoute();

        act(() => result.current.openChat("c1"));
        expect(result.current.chatId).toBe("c1");
        expect(window.location.pathname).toBe("/assistant/chat/c1");

        act(() => result.current.openChat(""));
        expect(result.current.chatId).toBe("");
        expect(window.location.pathname).toBe("/assistant");
        expect(pushState).toHaveBeenCalledTimes(2);
        pushState.mockRestore();
    });

    it("does not stack a history entry for the URL already shown", () => {
        const pushState = vi.spyOn(window.history, "pushState");
        const { result } = renderChatRoute();

        act(() => result.current.openChat(""));
        expect(pushState).not.toHaveBeenCalled();
        pushState.mockRestore();
    });

    it("follows real navigations such as a sidebar link or back", () => {
        const { result, rerender } = renderChatRoute();
        act(() => result.current.openChat("c1"));

        navigation.pathname = "/assistant/chat/c2";
        rerender();
        expect(result.current.chatId).toBe("c2");

        navigation.pathname = "/assistant";
        rerender();
        expect(result.current.chatId).toBe("");
    });

    it("claims an adopted chat exactly once, so its messages are not reloaded", () => {
        const { result } = renderChatRoute();

        act(() => result.current.adoptChat("c1"));
        expect(result.current.chatId).toBe("c1");
        expect(window.location.pathname).toBe("/assistant/chat/c1");
        expect(result.current.claimCreated("c1")).toBe(true);
        expect(result.current.claimCreated("c1")).toBe(false);
    });

    it("opens a side chat in the query, keeping the primary chat's path", () => {
        const { result } = renderChatRoute();
        expect(result.current.sideChatId).toBeNull();

        act(() => result.current.openChat("c1"));
        act(() => result.current.openSideChat(""));
        expect(result.current.sideChatId).toBe("");
        expect(window.location.pathname).toBe("/assistant/chat/c1");
        expect(window.location.search).toBe("?side=new");

        act(() => result.current.openSideChat("c2"));
        expect(result.current.sideChatId).toBe("c2");
        expect(window.location.search).toBe("?side=c2");

        act(() => result.current.openChat("c3"));
        expect(window.location.pathname).toBe("/assistant/chat/c3");
        expect(window.location.search).toBe("?side=c2");

        act(() => result.current.closeSideChat());
        expect(result.current.sideChatId).toBeNull();
        expect(window.location.search).toBe("");
    });

    it("restores the side chat from the URL after mount", () => {
        window.history.replaceState(null, "", "/assistant?side=c2");
        expect(renderChatRoute().result.current.sideChatId).toBe("c2");
    });

    it("never shows one chat in both places", () => {
        const { result, rerender } = renderChatRoute();
        act(() => result.current.openChat("c1"));

        act(() => result.current.openSideChat("c1"));
        expect(result.current.sideChatId).toBeNull();

        act(() => result.current.openSideChat("c2"));
        act(() => result.current.openChat("c2"));
        expect(result.current.sideChatId).toBeNull();
        expect(window.location.search).toBe("");

        act(() => result.current.openSideChat("c3"));
        navigation.pathname = "/assistant/chat/c3";
        rerender();
        expect(result.current.chatId).toBe("c3");
        expect(result.current.sideChatId).toBeNull();
    });

    it("keeps the side chat across a sidebar link, and follows back", () => {
        const { result, rerender } = renderChatRoute();
        act(() => result.current.openSideChat("c2"));

        // A link names only the primary chat.
        window.history.replaceState(null, "", "/assistant/chat/c1");
        navigation.pathname = "/assistant/chat/c1";
        rerender();
        expect(result.current.sideChatId).toBe("c2");
        expect(window.location.search).toBe("?side=c2");

        window.history.replaceState(null, "", "/assistant/chat/c1");
        act(() => {
            window.dispatchEvent(new PopStateEvent("popstate"));
        });
        expect(result.current.sideChatId).toBeNull();
        expect(window.location.search).toBe("");
    });

    it("claims a chat created in the side pane", () => {
        const { result } = renderChatRoute();
        act(() => result.current.openSideChat(""));

        act(() => result.current.adoptSideChat("c2"));
        expect(result.current.sideChatId).toBe("c2");
        expect(result.current.chatId).toBe("");
        expect(result.current.claimCreated("c2")).toBe(true);
        expect(result.current.claimCreated("c2")).toBe(false);
    });

    it("does not claim a chat that was opened rather than created", () => {
        const { result } = renderChatRoute();

        act(() => result.current.openChat("c1"));
        expect(result.current.claimCreated("c1")).toBe(false);
    });
});
