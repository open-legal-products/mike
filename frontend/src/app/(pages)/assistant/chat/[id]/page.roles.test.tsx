import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Grant-reachable chats appear in the global sidebar since the parity
// change, so a project viewer can land on this page. GET /chat/:id serves
// the caller's standing; this file pins that the page actually consumes it
// — dropping it handed a viewer a live composer whose sends 403.

const { getChat, loadChats, chatOptions, sideChatRequest, requestSideChat } =
    vi.hoisted(() => ({
    sideChatRequest: { current: null as string | null },
    requestSideChat: vi.fn(),
    getChat: vi.fn(),
    loadChats: vi.fn(),
    chatOptions: {
        current: null as null | { onChatCreated?: (chatId: string) => void },
    },
}));

vi.mock("next/navigation", () => ({
    usePathname: () => window.location.pathname,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/app/lib/mikeApi", () => ({
    getChat: (...args: unknown[]) => getChat(...args),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        setSideChatId: () => {},
        sideChatRequest: sideChatRequest.current,
        requestSideChat,
        setCurrentChatId: vi.fn(),
        newChatMessages: null,
        setNewChatMessages: vi.fn(),
        loadChats,
    }),
}));
vi.mock("@/app/hooks/useAssistantChat", () => ({
    useAssistantChat: (options: {
        onChatCreated?: (chatId: string) => void;
    }) => {
        chatOptions.current = options;
        return {
            messages: [],
            isResponseLoading: false,
            handleChat: vi.fn(),
            setMessages: vi.fn(),
            cancel: vi.fn(),
            detach: vi.fn(),
            resetChat: vi.fn(),
        };
    },
}));
vi.mock("@/app/components/assistant/useAssistantDocumentPanel", () => ({
    useAssistantDocumentPanel: () => ({}),
}));
vi.mock("@/app/components/assistant/AssistantDocumentPanelHost", () => ({
    AssistantDocumentPanelHost: () => null,
}));
vi.mock("@/app/components/assistant/ChatView", () => ({
    AssistantChatColumn: ({
        canSend,
        accessResolved,
        chat,
        chatId,
        paneId,
        hiddenChatId,
        onOpenSideChat,
        onCloseSideChat,
        onLoadChat,
    }: {
        canSend?: boolean | null;
        accessResolved?: boolean;
        chat?: { access_role?: string } | null;
        chatId?: string | null;
        paneId?: string;
        hiddenChatId?: string | null;
        onOpenSideChat?: () => void;
        onCloseSideChat?: () => void;
        onLoadChat?: (chatId: string) => void;
    }) =>
        paneId === "side" ? (
            <div data-testid="side-chat">
                <span data-testid="side-chat-id">{chatId ?? "new"}</span>
                <span data-testid="side-hidden-chat">{hiddenChatId}</span>
                <button type="button" onClick={() => onLoadChat?.("chat-2")}>
                    Load chat-2 beside
                </button>
                <button type="button" onClick={onCloseSideChat}>
                    Close side chat
                </button>
            </div>
        ) : (
            <>
                <span data-testid="can-send">{String(canSend)}</span>
                <span data-testid="access-resolved">
                    {String(accessResolved)}
                </span>
                <span data-testid="chat-role">
                    {chat?.access_role ?? "unknown"}
                </span>
                {onOpenSideChat && (
                    <button type="button" onClick={onOpenSideChat}>
                        Open side chat
                    </button>
                )}
            </>
        ),
}));

import AssistantChatPage from "./page";

function chatDetail(access_role: "owner" | "editor" | "viewer") {
    return {
        chat: {
            id: "chat-1",
            title: "Quarterly filing",
            model: null,
            reasoning_level: null,
            is_owner: false,
            access_role,
        },
        messages: [{ id: "m1", role: "user", content: "hi" }],
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/assistant/chat/chat-1");
});

describe("side chat", () => {
    it("opens a second chat beside the first, and closes it again", async () => {
        getChat.mockResolvedValue(chatDetail("owner"));
        render(<AssistantChatPage />);
        expect(screen.queryByTestId("side-chat")).not.toBeInTheDocument();

        await act(async () => {
            screen.getByRole("button", { name: "Open side chat" }).click();
        });
        expect(screen.getByTestId("side-chat-id")).toHaveTextContent("new");
        expect(window.location.search).toBe("?side=new");
        // Only one side chat: the primary no longer offers another.
        expect(
            screen.queryByRole("button", { name: "Open side chat" }),
        ).not.toBeInTheDocument();
        // The history list beside it leaves out the primary chat.
        expect(screen.getByTestId("side-hidden-chat")).toHaveTextContent(
            "chat-1",
        );

        await act(async () => {
            screen.getByRole("button", { name: "Load chat-2 beside" }).click();
        });
        expect(screen.getByTestId("side-chat-id")).toHaveTextContent("chat-2");
        expect(window.location.pathname).toBe("/assistant/chat/chat-1");
        expect(window.location.search).toBe("?side=chat-2");

        await act(async () => {
            screen.getByRole("button", { name: "Close side chat" }).click();
        });
        expect(screen.queryByTestId("side-chat")).not.toBeInTheDocument();
        expect(window.location.search).toBe("");
    });

    it("opens the chat a sidebar row asked for, and clears the request", async () => {
        getChat.mockResolvedValue(chatDetail("owner"));
        sideChatRequest.current = "chat-7";
        render(<AssistantChatPage />);

        await waitFor(() =>
            expect(screen.getByTestId("side-chat-id")).toHaveTextContent(
                "chat-7",
            ),
        );
        expect(requestSideChat).toHaveBeenCalledWith(null);
        expect(window.location.search).toBe("?side=chat-7");
        sideChatRequest.current = null;
    });

    it("restores the side chat named in the URL", async () => {
        getChat.mockResolvedValue(chatDetail("owner"));
        window.history.replaceState(
            null,
            "",
            "/assistant/chat/chat-1?side=chat-2",
        );
        render(<AssistantChatPage />);

        await waitFor(() =>
            expect(screen.getByTestId("side-chat-id")).toHaveTextContent(
                "chat-2",
            ),
        );
    });
});

describe("global new chat", () => {
    beforeEach(() => {
        window.history.replaceState(null, "", "/assistant");
    });

    it("opens writable without loading a chat", () => {
        render(<AssistantChatPage />);

        expect(screen.getByTestId("can-send")).toHaveTextContent("true");
        expect(screen.getByTestId("access-resolved")).toHaveTextContent("true");
        expect(getChat).not.toHaveBeenCalled();
    });

    it("adopts the created chat in place instead of reloading it", async () => {
        render(<AssistantChatPage />);

        await act(async () => {
            chatOptions.current?.onChatCreated?.("chat-9");
        });

        expect(window.location.pathname).toBe("/assistant/chat/chat-9");
        expect(loadChats).toHaveBeenCalled();
        expect(getChat).not.toHaveBeenCalled();
        expect(screen.getByTestId("can-send")).toHaveTextContent("true");
    });
});

describe("global chat page composer gating", () => {
    it("hands a project viewer a read-only composer", async () => {
        getChat.mockResolvedValue(chatDetail("viewer"));
        render(<AssistantChatPage />);
        // `canSend` also opens at false, so wait on the served role instead.
        await waitFor(() =>
            expect(screen.getByTestId("chat-role")).toHaveTextContent("viewer"),
        );
        expect(screen.getByTestId("can-send")).toHaveTextContent("false");
    });

    it("holds the composer back until the served standing lands", async () => {
        let resolveChat!: (detail: ReturnType<typeof chatDetail>) => void;
        getChat.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveChat = resolve;
                }),
        );
        render(<AssistantChatPage />);

        // Unknown, not denied: `canSend` is false here, so rendering the
        // composer would show an editor the read-only placeholder.
        expect(screen.getByTestId("can-send")).toHaveTextContent("false");
        expect(screen.getByTestId("access-resolved")).toHaveTextContent(
            "false",
        );

        await act(async () => {
            resolveChat(chatDetail("editor"));
        });

        expect(screen.getByTestId("access-resolved")).toHaveTextContent("true");
        expect(screen.getByTestId("can-send")).toHaveTextContent("true");
    });

    it("keeps the composer live for a role the server lets write", async () => {
        getChat.mockResolvedValue(chatDetail("editor"));
        render(<AssistantChatPage />);
        await waitFor(() =>
            expect(screen.getByTestId("can-send")).toHaveTextContent("true"),
        );
        expect(screen.getByTestId("chat-role")).toHaveTextContent("editor");
    });

    it("says 'not known yet' rather than 'viewing only' while getChat is in flight", async () => {
        // Every cold load starts with no initialMessages, so `canSend` opens
        // at FALSE — and a chat's own owner used to be told "Viewing only —
        // sending needs edit access" until the fetch landed. `accessResolved`
        // is the answer to that: false means "not known yet", and ChatView
        // keeps the composer off the page rather than showing the refusal.
        let settle!: (value: ReturnType<typeof chatDetail>) => void;
        getChat.mockReturnValue(
            new Promise((resolve) => {
                settle = resolve;
            }),
        );

        render(<AssistantChatPage />);

        expect(screen.getByTestId("access-resolved")).toHaveTextContent(
            "false",
        );

        await act(async () => {
            settle(chatDetail("owner"));
        });
        await waitFor(() =>
            expect(screen.getByTestId("can-send")).toHaveTextContent("true"),
        );
        expect(screen.getByTestId("access-resolved")).toHaveTextContent("true");
    });

    it("stays fail-closed when getChat never answers", async () => {
        getChat.mockRejectedValue(new Error("boom"));
        render(<AssistantChatPage />);

        await waitFor(() => expect(getChat).toHaveBeenCalled());
        // null, not true: an unknown standing is never a licence.
        expect(screen.getByTestId("can-send")).not.toHaveTextContent("true");
    });
});
