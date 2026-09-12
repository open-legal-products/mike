import {
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
import type { Chat, Message } from "@/app/components/shared/types";
import { ChatView } from "./ChatView";
import { PageChromeContext } from "@/app/contexts/PageChromeContext";

const {
    push,
    renameChat,
    deleteChat,
    setCurrentChatId,
    setNewChatMessages,
} = vi.hoisted(() => ({
    push: vi.fn(),
    renameChat: vi.fn(),
    deleteChat: vi.fn(),
    setCurrentChatId: vi.fn(),
    setNewChatMessages: vi.fn(),
}));

const activeChat: Chat = {
    id: "chat-1",
    project_id: null,
    user_id: "user-1",
    title: "Quarterly filing",
    created_at: new Date().toISOString(),
    is_owner: true,
    access_role: "owner",
};

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push }),
}));
vi.mock("@/app/contexts/SidebarContext", () => ({
    useSidebar: () => ({ setSidebarOpen: vi.fn() }),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        chats: [
            {
                id: "chat-1",
                project_id: null,
                user_id: "user-1",
                title: "Quarterly filing",
                created_at: "2026-01-01T00:00:00.000Z",
                is_owner: true,
                access_role: "owner",
            },
        ],
        renameChat,
        deleteChat,
        setCurrentChatId,
        setNewChatMessages,
    }),
}));
vi.mock("./ChatInput", () => ({
    ChatInput: () => <div>Chat input</div>,
}));
vi.mock("./UserMessage", () => ({ UserMessage: () => null }));
vi.mock("./AssistantMessage", () => ({
    AssistantMessage: ({ minHeight }: { minHeight?: string }) => (
        <div data-testid="assistant-message" style={{ minHeight }} />
    ),
}));
vi.mock("./AssistantWorkflowModal", () => ({
    AssistantWorkflowModal: () => null,
}));
vi.mock("./ChatAccessModal", () => ({
    ChatAccessModal: ({ open }: { open: boolean }) =>
        open ? <div>Chat access modal</div> : null,
}));

class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
}

function renderView(
    cancel = vi.fn(),
    messages: Message[] = [],
    mobileActionsContainer: HTMLElement | null = null,
) {
    render(
        withIntl(
            <PageChromeContext.Provider value={{ mobileActionsContainer }}>
                <ChatView
                    chatId="chat-1"
                    chat={activeChat}
                    messages={messages}
                    isResponseLoading={false}
                    handleChat={vi.fn().mockResolvedValue("chat-1")}
                    cancel={cancel}
                />
            </PageChromeContext.Provider>,
        ),
    );
    return { cancel };
}

function openActions() {
    const trigger = screen.getByRole("button", { name: "Ações da conversa" });
    fireEvent.pointerDown(
        trigger,
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
    );
    fireEvent.click(trigger);
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
        configurable: true,
        value: vi.fn(),
    });
    renameChat.mockResolvedValue(undefined);
    deleteChat.mockResolvedValue(undefined);
});

describe("ChatView header actions", () => {
    it("overlays PageHeader pills and starts a new chat", () => {
        const cancel = vi.fn();
        renderView(cancel);

        expect(
            document.querySelector('[data-slot="chat-header-actions"]'),
        ).toHaveClass("top-4.5");
        expect(
            document.querySelector('[data-slot="chat-messages-content"]'),
        ).toHaveStyle({ paddingTop: "76px" });

        fireEvent.click(
            screen.getByRole("button", { name: "Nova Conversa" }),
        );

        expect(cancel).toHaveBeenCalled();
        expect(setCurrentChatId).toHaveBeenCalledWith(null);
        expect(setNewChatMessages).toHaveBeenCalledWith(null);
        expect(push).toHaveBeenCalledWith("/assistant");
    });

    it("reduces the final assistant minimum height by the added header clearance", async () => {
        renderView(vi.fn(), [
            { id: "m1", role: "user", content: "Question" },
            { id: "m2", role: "assistant", content: "Answer" },
        ]);

        await waitFor(() =>
            expect(screen.getByTestId("assistant-message")).toHaveStyle({
                minHeight: "calc(100dvh - 256px)",
            }),
        );
    });

    it("opens chat access from Share", async () => {
        renderView();
        openActions();
        fireEvent.click(await screen.findByText("Compartilhar"));

        expect(await screen.findByText("Chat access modal")).toBeInTheDocument();
    });

    it("moves the chat actions into the mobile header container", () => {
        const mobileHeaderActions = document.createElement("div");
        document.body.appendChild(mobileHeaderActions);
        renderView(vi.fn(), [], mobileHeaderActions);

        expect(
            within(mobileHeaderActions).getByRole("button", {
                name: "Nova Conversa",
            }),
        ).toBeInTheDocument();
        expect(
            within(mobileHeaderActions).getByRole("button", {
                name: "Ações da conversa",
            }),
        ).toBeInTheDocument();
    });

    it("renames and deletes the active chat", async () => {
        vi.spyOn(window, "prompt").mockReturnValue("Renamed chat");
        renderView();

        openActions();
        fireEvent.click(await screen.findByText("Renomear"));
        await waitFor(() =>
            expect(renameChat).toHaveBeenCalledWith("chat-1", "Renamed chat"),
        );

        openActions();
        fireEvent.click(await screen.findByText("Excluir"));
        await waitFor(() => expect(deleteChat).toHaveBeenCalledWith("chat-1"));
        expect(push).toHaveBeenCalledWith("/assistant");
    });
});
