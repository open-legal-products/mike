import {
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, Document, Message } from "@/app/components/shared/types";
import { ChatView } from "./ChatView";
import { listDocumentVersions } from "@/app/lib/mikeApi";
import { PageChromeContext } from "@/app/contexts/PageChromeContext";

const { push, renameChat, deleteChat, setCurrentChatId, setNewChatMessages } =
    vi.hoisted(() => ({
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
const spreadsheet = {
    id: "excel-1",
    filename: "Budget.xlsx",
    file_type: "xlsx",
    current_version_id: "excel-v4",
    active_version_number: 4,
} as Document;
vi.mock("./ChatInput", () => ({
    ChatInput: ({
        onDocumentClick,
    }: {
        onDocumentClick?: (document: Document) => void;
    }) => (
        <button onClick={() => onDocumentClick?.(spreadsheet)}>
            Open Budget.xlsx
        </button>
    ),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "user-1", email: "user@example.com" } }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: null }),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    listDocumentVersions: vi.fn(),
    listQuickActions: vi.fn().mockResolvedValue([]),
}));
vi.mock("../shared/views/SpreadsheetView", () => ({
    SpreadsheetView: ({
        documentId,
        versionId,
        active,
    }: {
        documentId: string;
        versionId: string;
        active: boolean;
    }) => (
        <div
            data-testid="spreadsheet-viewer"
            data-document-id={documentId}
            data-version-id={versionId}
            data-active={String(active)}
        />
    ),
}));
vi.mock("../shared/views/PdfView", () => ({
    PdfView: () => <div data-testid="pdf-viewer" />,
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
    onInitialSubmit?: (message: Message) => void,
) {
    render(
        <PageChromeContext.Provider value={{ mobileActionsContainer }}>
            <ChatView
                chatId="chat-1"
                onInitialSubmit={onInitialSubmit}
                chat={activeChat}
                messages={messages}
                isResponseLoading={false}
                handleChat={vi.fn().mockResolvedValue("chat-1")}
                cancel={cancel}
            />
        </PageChromeContext.Provider>,
    );
    return { cancel };
}

function openActions() {
    const trigger = screen.getByRole("button", { name: "Chat actions" });
    fireEvent.pointerDown(
        trigger,
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
    );
    fireEvent.click(trigger);
}

beforeEach(() => {
    vi.clearAllMocks();
    spreadsheet.id = "excel-1";
    spreadsheet.filename = "Budget.xlsx";
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

        fireEvent.click(screen.getByRole("button", { name: "New chat" }));

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
        fireEvent.click(await screen.findByText("Share"));

        expect(
            await screen.findByText("Chat access modal"),
        ).toBeInTheDocument();
    });

    it("moves the chat actions into the mobile header container", () => {
        const mobileHeaderActions = document.createElement("div");
        document.body.appendChild(mobileHeaderActions);
        renderView(vi.fn(), [], mobileHeaderActions);

        expect(
            within(mobileHeaderActions).getByRole("button", {
                name: "New chat",
            }),
        ).toBeInTheDocument();
        expect(
            within(mobileHeaderActions).getByRole("button", {
                name: "Chat actions",
            }),
        ).toBeInTheDocument();
    });

    it("renames and deletes the active chat", async () => {
        vi.spyOn(window, "prompt").mockReturnValue("Renamed chat");
        renderView();

        openActions();
        fireEvent.click(await screen.findByText("Rename"));
        await waitFor(() =>
            expect(renameChat).toHaveBeenCalledWith("chat-1", "Renamed chat"),
        );

        openActions();
        fireEvent.click(await screen.findByText("Delete"));
        await waitFor(() => expect(deleteChat).toHaveBeenCalledWith("chat-1"));
        expect(push).toHaveBeenCalledWith("/assistant");
    });
});

describe("Excel attachment previews", () => {
    it.each([false, true])(
        "opens an Excel input pill in the side panel (initial composer: %s)",
        async (initial) => {
            renderView(vi.fn(), [], null, initial ? vi.fn() : undefined);
            fireEvent.click(
                screen.getByRole("button", { name: "Open Budget.xlsx" }),
            );
            const viewer = await screen.findByTestId("spreadsheet-viewer");
            expect(viewer).toHaveAttribute("data-document-id", "excel-1");
            expect(viewer).toHaveAttribute("data-version-id", "excel-v4");
            expect(screen.queryByTestId("pdf-viewer")).not.toBeInTheDocument();
            expect(listDocumentVersions).not.toHaveBeenCalled();
            // Repeated pill clicks activate the existing tab.
            fireEvent.click(
                screen.getByRole("button", { name: "Open Budget.xlsx" }),
            );
            await waitFor(() =>
                expect(
                    screen.getAllByTestId("spreadsheet-viewer"),
                ).toHaveLength(1),
            );
        },
    );
});

it("keeps an initial attachment preview open when the first message arrives", async () => {
    const initialSubmit = vi.fn();
    const view = (messages: Message[], initial: boolean) => (
        <PageChromeContext.Provider value={{ mobileActionsContainer: null }}>
            <ChatView
                messages={messages}
                isResponseLoading={false}
                handleChat={vi.fn().mockResolvedValue("chat-1")}
                cancel={vi.fn()}
                onInitialSubmit={initial ? initialSubmit : undefined}
            />
        </PageChromeContext.Provider>
    );
    const { rerender } = render(view([], true));
    fireEvent.click(screen.getByRole("button", { name: "Open Budget.xlsx" }));
    const viewer = await screen.findByTestId("spreadsheet-viewer");
    rerender(view([{ role: "user", content: "Review this workbook" }], false));
    expect(screen.getByTestId("spreadsheet-viewer")).toBe(viewer);
    expect(
        screen.getByRole("button", { name: "Open Budget.xlsx" }),
    ).toBeInTheDocument();
});

it("suspends inactive spreadsheet tabs in the assistant side panel", async () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Open Budget.xlsx" }));
    const first = await screen.findByTestId("spreadsheet-viewer");
    expect(first).toHaveAttribute("data-active", "true");
    spreadsheet.id = "excel-2";
    spreadsheet.filename = "Other.xlsx";
    fireEvent.click(screen.getByRole("button", { name: "Open Budget.xlsx" }));
    await waitFor(() =>
        expect(screen.getAllByTestId("spreadsheet-viewer")).toHaveLength(2),
    );
    expect(first).toHaveAttribute("data-active", "false");
    expect(first.closest('[aria-hidden="true"]')).toHaveAttribute("inert");
});
