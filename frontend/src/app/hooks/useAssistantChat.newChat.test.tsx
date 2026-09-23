/**
 * A brand-new chat is two steps: create the chat row, then stream the turn.
 * When the create fails the user has already seen their bubble appear, so
 * the hook must return to the empty state and hand the caller's retry to
 * the toast, or the message is stranded above a composer with no chat.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/app/components/shared/types";

const { saveChatMock, setNewChatMessagesMock } = vi.hoisted(() => ({
    saveChatMock: vi.fn(),
    setNewChatMessagesMock: vi.fn(),
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        replaceChatId: vi.fn(),
        loadChats: vi.fn().mockResolvedValue(undefined),
        setCurrentChatId: vi.fn(),
        saveChat: saveChatMock,
        setNewChatMessages: setNewChatMessagesMock,
        updateChatTitle: vi.fn(),
    }),
}));
import { useAssistantChat } from "./useAssistantChat";

const message: Message = { role: "user", content: "hello" };

describe("useAssistantChat.handleNewChat", () => {
    beforeEach(() => {
        saveChatMock.mockReset();
        setNewChatMessagesMock.mockReset();
    });

    it("forwards the caller's retry to the chat store and keeps the bubble on success", async () => {
        saveChatMock.mockResolvedValue("chat-1");
        const onRetry = vi.fn();
        const { result } = renderHook(() => useAssistantChat());

        let id: string | null = null;
        await act(async () => {
            id = await result.current.handleNewChat(message, "proj-1", {
                onRetry,
            });
        });

        expect(id).toBe("chat-1");
        expect(saveChatMock).toHaveBeenCalledWith("proj-1", undefined, { onRetry });
        expect(result.current.messages).toEqual([message]);
        expect(result.current.chatId).toBe("chat-1");
    });

    it("returns to the empty state when the chat could not be created", async () => {
        saveChatMock.mockResolvedValue(null);
        const { result } = renderHook(() => useAssistantChat());

        await act(async () => {
            await result.current.handleNewChat(message);
        });

        expect(result.current.messages).toEqual([]);
        expect(result.current.chatId).toBeUndefined();
        expect(setNewChatMessagesMock).toHaveBeenLastCalledWith([]);
    });
});
