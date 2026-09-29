import { useImperativeHandle, type Ref } from "react";
import type { ChatInputHandle } from "./ChatInput";
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
import {
    listDocumentVersions,
    getDocument,
    renameProjectDocument,
    renameLibraryDocument,
    deleteDocument,
    getDocumentFile,
} from "@/app/lib/mikeApi";
import { PageChromeContext } from "@/app/contexts/PageChromeContext";

const { push, renameChat, deleteChat, setCurrentChatId, setNewChatMessages } =
    vi.hoisted(() => ({
        push: vi.fn(),
        renameChat: vi.fn(),
        deleteChat: vi.fn(),
        setCurrentChatId: vi.fn(),
        setNewChatMessages: vi.fn(),
    }));

const addDoc = vi.hoisted(() => vi.fn());

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
        onDocumentClick, ref,
    }: {
        onDocumentClick?: (document: Document) => void;
        ref?: Ref<ChatInputHandle>;
    }) => {
        useImperativeHandle(ref, () => ({ addDoc, addFiles: vi.fn(), startWorkflow: vi.fn(), startWorkflowDocumentSelection: vi.fn() }));
        return <button onClick={() => onDocumentClick?.(spreadsheet)}>
            Open Budget.xlsx
        </button>;
    },
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
    getDocument: vi.fn(),
    renameProjectDocument: vi.fn(),
    renameLibraryDocument: vi.fn(),
    deleteDocument: vi.fn(),
    getDocumentFile: vi.fn(),
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
vi.mock("./UserMessage", () => ({
    UserMessage: ({ content }: { content: string }) => <div>{content}</div>,
}));
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
    detach = vi.fn(),
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
                detach={detach}
            />
        </PageChromeContext.Provider>,
    );
    return { cancel, detach };
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
    vi.mocked(listDocumentVersions).mockResolvedValue({
        current_version_id: "excel-v4",
        versions: [
            {
                id: "excel-v4",
                version_number: 4,
                filename: "Budget.xlsx",
                source: "upload",
                created_at: "2026-09-26",
            },
        ],
    });
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
        const detach = vi.fn();
        renderView(cancel, [], null, undefined, detach);

        expect(
            document.querySelector('[data-slot="chat-header-actions"]'),
        ).toHaveClass("top-4.5");
        expect(
            document.querySelector('[data-slot="chat-messages-content"]'),
        ).toHaveStyle({ paddingTop: "76px" });

        fireEvent.click(screen.getByRole("button", { name: "New chat" }));

        // New chat leaves the in-flight answer running (detach); only the
        // Stop control aborts it, because the backend persists an aborted
        // stream as a truncated "Cancelled by user." answer.
        expect(detach).toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
        expect(setCurrentChatId).toHaveBeenCalledWith(null);
        expect(setNewChatMessages).toHaveBeenCalledWith(null);
        expect(push).toHaveBeenCalledWith("/assistant");
    });

    it("sizes the final response from the scroll viewport so the latest question lands at the top offset", async () => {
        // An 800px scroll viewport and a 44px user message. Scrolled to the
        // bottom, the question must sit 76px below the top: 800 - 76 - 44 -
        // two 32px list gaps (response, trailing anchor) - 116px padding.
        const clientHeight = vi
            .spyOn(HTMLElement.prototype, "clientHeight", "get")
            .mockImplementation(function (this: HTMLElement) {
                return this.firstElementChild?.getAttribute("data-slot") ===
                    "chat-messages-content"
                    ? 800
                    : 0;
            });
        const offsetHeight = vi
            .spyOn(HTMLElement.prototype, "offsetHeight", "get")
            .mockReturnValue(44);
        try {
            renderView(vi.fn(), [
                { id: "m1", role: "user", content: "Question" },
                { id: "m2", role: "assistant", content: "Answer" },
            ]);

            await waitFor(() =>
                expect(screen.getByTestId("assistant-message")).toHaveStyle({
                    minHeight: "500px",
                }),
            );
        } finally {
            clientHeight.mockRestore();
            offsetHeight.mockRestore();
        }
    });

    it("positions a detached chat after its full history replaces the live overlay", async () => {
        const handleChat = vi.fn().mockResolvedValue("chat-2");
        const view = (chatLoading: boolean, messages: Message[]) => (
            <PageChromeContext.Provider
                value={{ mobileActionsContainer: null }}
            >
                <ChatView
                    chatId="chat-2"
                    chat={{ ...activeChat, id: "chat-2" }}
                    messages={messages}
                    isResponseLoading
                    chatLoading={chatLoading}
                    handleChat={handleChat}
                    cancel={vi.fn()}
                    detach={vi.fn()}
                />
            </PageChromeContext.Provider>
        );
        const liveOverlay: Message[] = [
            { id: "latest-user", role: "user", content: "Latest question" },
            { id: "live-answer", role: "assistant", content: "Loading" },
        ];
        const { rerender } = render(view(true, liveOverlay));
        const container = document.querySelector(
            '[data-slot="chat-messages-content"]',
        )?.parentElement as HTMLDivElement;
        Object.defineProperty(container, "scrollTop", {
            configurable: true,
            value: 50,
            writable: true,
        });
        vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
            top: 100,
        } as DOMRect);

        rerender(
            view(false, [
                { id: "old-user", role: "user", content: "Older question" },
                {
                    id: "old-answer",
                    role: "assistant",
                    content: "Older answer",
                },
                ...liveOverlay,
            ]),
        );
        const latest = screen.getByText("Latest question").parentElement!;
        vi.spyOn(latest, "getBoundingClientRect").mockReturnValue({
            top: 700,
        } as DOMRect);

        await waitFor(() =>
            expect(container.scrollTo).toHaveBeenCalledWith({
                top: 574,
                behavior: "auto",
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
            expect(listDocumentVersions).toHaveBeenCalledWith("excel-1");
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
                detach={vi.fn()}
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

describe("ChatView composer gating", () => {
    const view = (accessResolved: boolean) => (
        <PageChromeContext.Provider value={{ mobileActionsContainer: null }}>
            <ChatView
                chatId="chat-1"
                chat={activeChat}
                messages={[]}
                isResponseLoading={false}
                handleChat={vi.fn().mockResolvedValue("chat-1")}
                cancel={vi.fn()}
                detach={vi.fn()}
                canSend={false}
                accessResolved={accessResolved}
            />
        </PageChromeContext.Provider>
    );

    it("renders no composer until the caller's standing is known", () => {
        const { rerender } = render(view(false));
        expect(
            screen.queryByRole("button", { name: "Open Budget.xlsx" }),
        ).toBeNull();

        rerender(view(true));
        expect(
            screen.getByRole("button", { name: "Open Budget.xlsx" }),
        ).toBeInTheDocument();
    });

    it("renders the composer by default for callers that know the standing", () => {
        renderView();
        expect(
            screen.getByRole("button", { name: "Open Budget.xlsx" }),
        ).toBeInTheDocument();
    });
});

describe("rejected API key", () => {
    function renderWithRejectedKey(model: string | null) {
        const onDismiss = vi.fn();
        render(
            <PageChromeContext.Provider
                value={{ mobileActionsContainer: null }}
            >
                <ChatView
                    chatId="chat-1"
                    chat={activeChat}
                    messages={[]}
                    isResponseLoading={false}
                    handleChat={vi.fn().mockResolvedValue("chat-1")}
                    cancel={vi.fn()}
                    detach={vi.fn()}
                    rejectedApiKey={{ model }}
                    onDismissInvalidApiKey={onDismiss}
                />
            </PageChromeContext.Provider>,
        );
        return { onDismiss };
    }

    it("warns that the key was rejected and names the provider", () => {
        // Retrying cannot help, so the popup has to point at the key rather
        // than repeat the generic try-again error.
        renderWithRejectedKey("claude-opus-4-7");

        const alert = screen.getByRole("alert");
        expect(within(alert).getByText("API key rejected")).toBeInTheDocument();
        expect(alert).toHaveTextContent(
            /The Anthropic \(Claude\) API key was rejected/,
        );
        expect(
            within(alert).getByRole("button", { name: "Go to settings" }),
        ).toBeInTheDocument();
    });

    it("falls back to neutral wording for an unrecognized model", () => {
        renderWithRejectedKey("some-unlisted-model");

        expect(screen.getByRole("alert")).toHaveTextContent(
            /That API key was rejected/,
        );
    });

    it("still warns when the send carried no model", () => {
        // An ask-inputs response submits without a model, so the popup cannot
        // depend on having one — it just loses the provider's name.
        renderWithRejectedKey(null);

        expect(screen.getByRole("alert")).toHaveTextContent(
            /That API key was rejected/,
        );
    });

    it("stays hidden while no key has been rejected", () => {
        render(
            <PageChromeContext.Provider
                value={{ mobileActionsContainer: null }}
            >
                <ChatView
                    chatId="chat-1"
                    chat={activeChat}
                    messages={[]}
                    isResponseLoading={false}
                    handleChat={vi.fn().mockResolvedValue("chat-1")}
                    cancel={vi.fn()}
                    detach={vi.fn()}
                    rejectedApiKey={null}
                    onDismissInvalidApiKey={vi.fn()}
                />
            </PageChromeContext.Provider>,
        );

        expect(screen.queryByText("API key rejected")).not.toBeInTheDocument();
    });

    it("reports dismissal so the same failure does not reopen it", () => {
        const { onDismiss } = renderWithRejectedKey("claude-opus-4-7");

        fireEvent.click(
            screen.getByRole("button", { name: "Dismiss warning" }),
        );
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });
});

describe("assistant document tab actions", () => {
    it.each([false, true])("adds a tab's document to the composer (initial view: %s)", async (initial) => {
        vi.mocked(getDocument).mockResolvedValue(spreadsheet);
        renderView(vi.fn(), [], null, initial ? vi.fn() : undefined);
        fireEvent.click(screen.getByRole("button", { name: "Open Budget.xlsx" }));
        fireEvent.contextMenu(await screen.findByRole("tab", { name: "Budget.xlsx" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "Add to chat" }));
        await waitFor(() => expect(addDoc).toHaveBeenCalledWith(spreadsheet));
    });

    it.each([null, "project-1"])(
        "renames the persisted file in its owning scope %s",
        async (projectId) => {
            const file = { ...spreadsheet, project_id: projectId };
            vi.mocked(getDocument).mockResolvedValue(file);
            vi.mocked(renameProjectDocument).mockResolvedValue({
                ...file,
                filename: "Renamed.xlsx",
            });
            vi.mocked(renameLibraryDocument).mockResolvedValue({
                ...file,
                filename: "Renamed.xlsx",
            });
            renderView();
            fireEvent.click(
                screen.getByRole("button", { name: "Open Budget.xlsx" }),
            );
            const tab = await screen.findByRole("tab", { name: "Budget.xlsx" });
            fireEvent.contextMenu(tab);
            fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
            const input = screen.getByRole("textbox", { name: "File name" });
            fireEvent.change(input, { target: { value: "Renamed.xlsx" } });
            fireEvent.keyDown(input, { key: "Enter" });
            expect(
                await screen.findByRole("tab", { name: "Renamed.xlsx" }),
            ).toBeVisible();
            if (projectId) {
                expect(renameProjectDocument).toHaveBeenCalledWith(
                    projectId,
                    "excel-1",
                    "Renamed.xlsx",
                );
                expect(renameLibraryDocument).not.toHaveBeenCalled();
            } else {
                expect(renameLibraryDocument).toHaveBeenCalledWith(
                    "files",
                    "excel-1",
                    "Renamed.xlsx",
                );
                expect(renameProjectDocument).not.toHaveBeenCalled();
            }
        },
    );

    it("downloads the version represented by the tab", async () => {
        vi.mocked(getDocumentFile).mockRejectedValue(
            new Error("internal storage error"),
        );
        renderView();
        fireEvent.click(
            screen.getByRole("button", { name: "Open Budget.xlsx" }),
        );
        fireEvent.contextMenu(
            await screen.findByRole("tab", { name: "Budget.xlsx" }),
        );
        fireEvent.click(screen.getByRole("menuitem", { name: "Download" }));
        await waitFor(() =>
            expect(getDocumentFile).toHaveBeenCalledWith("excel-1", "excel-v4"),
        );
        expect(
            await screen.findByText(
                "This file action could not be completed. Please try again.",
            ),
        ).toBeVisible();
        expect(screen.queryByText("internal storage error")).toBeNull();
    });

    it("keeps the tab on a failed deletion and closes it after success", async () => {
        vi.mocked(deleteDocument)
            .mockRejectedValueOnce(new Error("private database details"))
            .mockResolvedValueOnce(undefined);
        renderView();
        fireEvent.click(
            screen.getByRole("button", { name: "Open Budget.xlsx" }),
        );
        fireEvent.contextMenu(
            await screen.findByRole("tab", { name: "Budget.xlsx" }),
        );
        fireEvent.click(screen.getByRole("menuitem", { name: "Delete file" }));
        expect(
            await screen.findByText(
                "This file action could not be completed. Please try again.",
            ),
        ).toBeVisible();
        expect(screen.getByRole("tab", { name: "Budget.xlsx" })).toBeVisible();
        fireEvent.click(
            screen.getByRole("button", { name: "Dismiss warning" }),
        );
        fireEvent.contextMenu(screen.getByRole("tab", { name: "Budget.xlsx" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "Delete file" }));
        await waitFor(() =>
            expect(
                screen.queryByRole("tab", { name: "Budget.xlsx" }),
            ).toBeNull(),
        );
        expect(deleteDocument).toHaveBeenCalledWith("excel-1");
    });
});
