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

    it("does not claim a chat that was opened rather than created", () => {
        const { result } = renderChatRoute();

        act(() => result.current.openChat("c1"));
        expect(result.current.claimCreated("c1")).toBe(false);
    });
});
