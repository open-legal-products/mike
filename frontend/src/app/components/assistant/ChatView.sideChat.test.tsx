import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/app/components/shared/types";
import { AssistantChatColumn } from "./ChatView";
import { useAssistantDocumentPanel } from "./useAssistantDocumentPanel";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/app/contexts/SidebarContext", () => ({
    // A new function on every render, as the shell's provider hands out.
    useSidebar: () => ({ setSidebarOpen: vi.fn() }),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        chats: [
            { id: "chat-1", title: "Quarterly filing" },
            { id: "chat-2", title: "Lease review" },
            { id: "chat-3", title: "Board minutes" },
        ],
        hasMoreChats: false,
        loadingMoreChats: false,
        loadMoreChats: vi.fn(),
        renameChat: vi.fn(),
        deleteChat: vi.fn(),
    }),
}));
vi.mock("@/app/hooks/useQuickActions", () => ({
    useQuickActions: () => ({
        quickActions: [],
        saveQuickAction: vi.fn(),
        addQuickAction: vi.fn(),
    }),
}));
vi.mock("./ChatInput", () => ({ ChatInput: () => <div>Composer</div> }));
vi.mock("./InitialView", () => ({
    InitialView: () => <div>Initial view</div>,
}));
vi.mock("./UserMessage", () => ({
    UserMessage: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock("./AssistantMessage", () => ({ AssistantMessage: () => null }));
vi.mock("./QuickActionsModal", () => ({ QuickActionsModal: () => null }));
vi.mock("./AssistantWorkflowModal", () => ({
    AssistantWorkflowModal: () => null,
}));
vi.mock("./ChatAccessModal", () => ({ ChatAccessModal: () => null }));

const started: Message[] = [{ role: "user", content: "Summarise the lease" }];

function Column({
    newChat = false,
    onLoadChat = vi.fn(),
    onOpenSideChat,
    onCloseSideChat,
    hiddenChatId,
}: {
    newChat?: boolean;
    onLoadChat?: (chatId: string) => void;
    onOpenSideChat?: () => void;
    onCloseSideChat?: () => void;
    hiddenChatId?: string;
}) {
    const documentPanel = useAssistantDocumentPanel();
    return (
        <AssistantChatColumn
            chatId={newChat ? null : "chat-1"}
            messages={newChat ? [] : started}
            onInitialSubmit={newChat ? vi.fn() : undefined}
            isResponseLoading={false}
            handleChat={vi.fn().mockResolvedValue(null)}
            cancel={vi.fn()}
            onNewChat={vi.fn()}
            documentPanel={documentPanel}
            onLoadChat={onLoadChat}
            onOpenSideChat={onOpenSideChat}
            onCloseSideChat={onCloseSideChat}
            hiddenChatId={hiddenChatId}
        />
    );
}

function press(element: HTMLElement) {
    fireEvent.pointerDown(
        element,
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
    );
    fireEvent.click(element);
}

function openActions() {
    press(screen.getByRole("button", { name: "Chat actions" }));
}

describe("AssistantChatColumn header", () => {
    beforeEach(() => {
        vi.stubGlobal(
            "ResizeObserver",
            class {
                observe() {}
                unobserve() {}
                disconnect() {}
            },
        );
    });

    it("offers the chat history on a new chat, where there is nothing to leave", () => {
        const onLoadChat = vi.fn();
        render(<Column newChat onLoadChat={onLoadChat} />);

        expect(
            screen.queryByRole("button", { name: "New chat" }),
        ).not.toBeInTheDocument();
        press(screen.getByRole("button", { name: "Chat history" }));
        fireEvent.click(screen.getByRole("menuitem", { name: /Lease review/ }));

        expect(onLoadChat).toHaveBeenCalledWith("chat-2");
    });

    it("has no Load chat action on a new chat", () => {
        render(<Column newChat />);
        openActions();

        expect(
            screen.queryByRole("menuitem", { name: "Load chat" }),
        ).not.toBeInTheDocument();
    });

    it("swaps the history button for New chat once the chat has started", () => {
        render(<Column />);

        expect(
            screen.getByRole("button", { name: "New chat" }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Chat history" }),
        ).not.toBeInTheDocument();
    });

    it("opens the chat history in place of the actions from Load chat", async () => {
        const onLoadChat = vi.fn();
        render(<Column onLoadChat={onLoadChat} />);
        openActions();
        fireEvent.click(screen.getByRole("menuitem", { name: "Load chat" }));

        fireEvent.click(
            await screen.findByRole("menuitem", { name: /Board minutes/ }),
        );
        expect(
            screen.queryByRole("menuitem", { name: "Rename" }),
        ).not.toBeInTheDocument();
        expect(onLoadChat).toHaveBeenCalledWith("chat-3");
    });

    it("leaves the chat in the other pane out of the history", () => {
        render(<Column newChat hiddenChatId="chat-2" />);
        press(screen.getByRole("button", { name: "Chat history" }));

        expect(
            screen.getByRole("menuitem", { name: /Board minutes/ }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("menuitem", { name: /Lease review/ }),
        ).not.toBeInTheDocument();
    });

    it("offers opening a side chat from the primary and closing it from the side", () => {
        const onOpenSideChat = vi.fn();
        const onCloseSideChat = vi.fn();
        const { unmount } = render(<Column onOpenSideChat={onOpenSideChat} />);
        openActions();
        fireEvent.click(
            screen.getByRole("menuitem", { name: "Open side chat" }),
        );
        expect(onOpenSideChat).toHaveBeenCalled();
        unmount();

        render(<Column onCloseSideChat={onCloseSideChat} />);
        openActions();
        expect(
            screen.queryByRole("menuitem", { name: "Open side chat" }),
        ).not.toBeInTheDocument();
        fireEvent.click(
            screen.getByRole("menuitem", { name: "Close side chat" }),
        );
        expect(onCloseSideChat).toHaveBeenCalled();
    });
});
