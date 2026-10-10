import { useImperativeHandle, type Ref } from "react";
import type { ChatInputHandle } from "./ChatInput";
import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    can_edit: true,
    can_delete: true,
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
        useImperativeHandle(ref, () => ({ addDoc, addFiles: vi.fn(), addExcerpt: vi.fn(), startWorkflow: vi.fn(), startWorkflowDocumentSelection: vi.fn() }));
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
    AssistantMessage: ({
        minHeight,
        awaitingInput,
    }: {
        minHeight?: string;
        awaitingInput?: boolean;
    }) => (
        <div
            data-testid="assistant-message"
            data-awaiting-input={String(!!awaitingInput)}
            style={{ minHeight }}
        />
    ),
}));
vi.mock("@/app/components/modals/AddDocumentsModal", () => ({
    AddDocumentsModal: ({
        open,
        onSelect,
    }: {
        open: boolean;
        onSelect: (documents: Document[]) => void;
    }) =>
        open ? (
            <button onClick={() => onSelect([spreadsheet])}>
                Pick Budget.xlsx
            </button>
        ) : null,
}));
vi.mock("./QuickActionsModal", () => ({
    QuickActionsModal: ({ open }: { open: boolean }) =>
        open ? <div>Quick actions modal</div> : null,
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
    onNewChat = vi.fn(),
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
                onNewChat={onNewChat}
            />
        </PageChromeContext.Provider>,
    );
    return { cancel, onNewChat };
}

function openActions() {
    const trigger = screen.getByRole("button", { name: "Chat actions" });
    fireEvent.pointerDown(
        trigger,
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
    );
    fireEvent.click(trigger);
}

describe("ChatView streaming scroll controls", () => {
    let frames: Map<number, FrameRequestCallback>;
    let observers: Map<Element, () => void>;
    let nextFrame: number;

    beforeEach(() => {
        frames = new Map();
        observers = new Map();
        nextFrame = 0;
        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
            frames.set(++nextFrame, callback);
            return nextFrame;
        });
        vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
        vi.stubGlobal("ResizeObserver", class {
            private targets = new Set<Element>();
            constructor(private callback: () => void) {}
            observe(target: Element) {
                this.targets.add(target);
                observers.set(target, this.callback);
            }
            disconnect() {
                for (const target of this.targets) observers.delete(target);
            }
        });
    });

    afterEach(() => vi.unstubAllGlobals());

    function flushFrame() {
        act(() => {
            const pending = [...frames.values()];
            frames.clear();
            for (const callback of pending) callback(performance.now());
        });
    }

    function view(chunk = "Answer", initial = false) {
        return (
            <PageChromeContext.Provider value={{ mobileActionsContainer: null }}>
                <ChatView
                    chatId="chat-1"
                    chat={activeChat}
                    messages={[
                        { id: "user", role: "user", content: "Question" },
                        { id: "answer", role: "assistant", content: chunk },
                    ]}
                    isResponseLoading
                    handleChat={vi.fn()}
                    cancel={vi.fn()}
                    onNewChat={vi.fn()}
                    onInitialSubmit={initial ? vi.fn() : undefined}
                />
            </PageChromeContext.Provider>
        );
    }

    function geometry() {
        const content = document.querySelector('[data-slot="chat-messages-content"]')!;
        const viewport = content.parentElement!;
        const size = { content: 600, viewport: 600 };
        const readHeight = vi.fn(() => size.content);
        Object.defineProperties(viewport, {
            scrollHeight: { configurable: true, get: readHeight },
            clientHeight: { configurable: true, get: () => size.viewport },
        });
        return { content, viewport, size, readHeight };
    }

    it("reveals a resumed transcript even when every animation frame receives another chunk", () => {
        const transcript = (chunk: string, chatLoading = false) => (
            <PageChromeContext.Provider value={{ mobileActionsContainer: null }}>
                <ChatView
                    chatId="chat-1"
                    chatLoading={chatLoading}
                    chat={activeChat}
                    messages={[
                        { id: "old-user", role: "user", content: "Earlier question" },
                        { id: "old-answer", role: "assistant", content: "Earlier answer" },
                        { id: "latest-user", role: "user", content: "Current question" },
                        { id: "live-answer", role: "assistant", content: chunk },
                    ]}
                    isResponseLoading
                    handleChat={vi.fn()}
                    cancel={vi.fn()}
                    onNewChat={vi.fn()}
                />
            </PageChromeContext.Provider>
        );
        const { rerender } = render(transcript("First chunk", true));
        rerender(transcript("First chunk"));
        for (let chunk = 0; chunk < 120; chunk++) {
            flushFrame();
            rerender(transcript(`Chunk ${chunk}`));
        }
        expect(document.querySelector('[data-slot="chat-messages-content"] .transition-opacity')).toHaveStyle({ opacity: "1" });
    });

    it("updates for revealed content, viewport resizing and scrolling without a new message", () => {
        render(view());
        const { content, viewport, size } = geometry();
        flushFrame();
        expect(screen.queryByRole("button", { name: "Scroll to bottom" })).toBeNull();

        size.content = 1000;
        act(() => observers.get(content)?.());
        flushFrame();
        expect(screen.getByRole("button", { name: "Scroll to bottom" })).toBeVisible();

        viewport.scrollTop = 390; // Within the existing 10px bottom threshold.
        fireEvent.scroll(viewport);
        flushFrame();
        expect(screen.queryByRole("button", { name: "Scroll to bottom" })).toBeNull();

        viewport.scrollTop = 0;
        fireEvent.scroll(viewport);
        flushFrame();
        expect(screen.getByRole("button", { name: "Scroll to bottom" })).toBeVisible();

        size.viewport = 1000;
        act(() => observers.get(viewport)?.());
        flushFrame();
        expect(screen.queryByRole("button", { name: "Scroll to bottom" })).toBeNull();
    });

    it("does not measure or enqueue scroll state on every streaming chunk", () => {
        const { rerender } = render(view());
        const { readHeight } = geometry();
        flushFrame();
        readHeight.mockClear();

        for (let chunk = 0; chunk < 120; chunk++) {
            rerender(view(`Streamed chunk ${chunk}`));
            flushFrame();
        }

        // Incoming data is not a layout signal. ResizeObserver will notify
        // when the revealed content actually changes the scroll geometry.
        expect(readHeight).not.toHaveBeenCalled();
    });

    it("coalesces layout notifications and cleans up pending measurements", () => {
        const { unmount } = render(view());
        const { content, viewport, readHeight } = geometry();
        flushFrame();
        readHeight.mockClear();
        act(() => {
            observers.get(content)?.();
            observers.get(viewport)?.();
            fireEvent.scroll(viewport);
        });
        flushFrame();
        expect(readHeight).toHaveBeenCalledTimes(1);

        act(() => observers.get(content)?.());
        unmount();
        readHeight.mockClear();
        fireEvent.scroll(viewport);
        flushFrame();
        expect(readHeight).not.toHaveBeenCalled();
        expect(observers.has(content)).toBe(false);
        expect(observers.has(viewport)).toBe(false);
    });

    it("starts observing when the initial screen becomes a conversation", () => {
        const { rerender } = render(view("Answer", true));
        rerender(view());
        const { content, size } = geometry();
        flushFrame();
        size.content = 1000;
        act(() => observers.get(content)?.());
        flushFrame();
        expect(screen.getByRole("button", { name: "Scroll to bottom" })).toBeVisible();
    });
});

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDocument).mockResolvedValue(spreadsheet);
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

describe("ChatView responses waiting on the user", () => {
    const question: Message = { role: "user", content: "Send the email" };
    const asking = {
        role: "assistant",
        content: "",
        events: [{ type: "ask_inputs", event_id: "ask-1", items: [] }],
    } as unknown as Message;
    const earlier = {
        role: "assistant",
        content: "Done.",
        events: [{ type: "content", text: "Done." }],
    } as unknown as Message;

    it("flags only the message that is still waiting for input or approval", () => {
        renderView(vi.fn(), [question, earlier, question, asking]);

        expect(
            screen
                .getAllByTestId("assistant-message")
                .map((message) => message.dataset.awaitingInput),
        ).toEqual(["false", "true"]);
    });

    it("stops flagging it once the user has replied", () => {
        renderView(vi.fn(), [question, asking, question]);

        expect(screen.getByTestId("assistant-message")).toHaveAttribute(
            "data-awaiting-input",
            "false",
        );
    });
});

describe("ChatView header actions", () => {
    it("overlays PageHeader pills and starts a new chat", () => {
        const cancel = vi.fn();
        const onNewChat = vi.fn();
        renderView(cancel, [], null, undefined, onNewChat);

        expect(
            document.querySelector('[data-slot="chat-header-actions"]'),
        ).toHaveClass("top-4.5");
        expect(
            document.querySelector('[data-slot="chat-messages-content"]'),
        ).toHaveStyle({ paddingTop: "76px" });

        fireEvent.click(screen.getByRole("button", { name: "New chat" }));

        // New chat leaves the in-flight answer running; only the Stop
        // control aborts it, because the backend persists an aborted stream
        // as a truncated "Cancelled by user." answer.
        expect(onNewChat).toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
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
                    onNewChat={vi.fn()}
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
        const prompt = vi.spyOn(window, "prompt");
        renderView();

        openActions();
        fireEvent.click(await screen.findByText("Rename"));
        const input = await screen.findByRole("textbox", { name: "Chat title" });
        fireEvent.change(input, { target: { value: "Renamed chat" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(prompt).not.toHaveBeenCalled();
        await waitFor(() =>
            expect(renameChat).toHaveBeenCalledWith("chat-1", "Renamed chat"),
        );

        openActions();
        fireEvent.click(await screen.findByText("Delete"));
        await waitFor(() => expect(deleteChat).toHaveBeenCalledWith("chat-1"));
        expect(push).toHaveBeenCalledWith("/assistant");
    });
});

describe("ChatView side panel and quick actions menu", () => {
    it.each([false, true])(
        "offers the side panel and quick actions (new chat: %s)",
        async (initial) => {
            renderView(vi.fn(), [], null, initial ? vi.fn() : undefined);

            // Chat-only controls wait until a chat exists.
            expect(
                screen.queryByRole("button", { name: "New chat" }) !== null,
            ).toBe(!initial);
            openActions();
            expect(
                await screen.findByRole("menuitem", {
                    name: "Open side panel",
                }),
            ).toBeInTheDocument();
            expect(
                screen.getByRole("menuitem", { name: "Edit quick actions" }),
            ).toBeInTheDocument();
            expect(
                screen.queryByRole("menuitem", { name: "Share" }) !== null,
            ).toBe(!initial);
        },
    );

    it("opens a blank side panel whose Open Documents picker opens documents", async () => {
        renderView(vi.fn(), [], null, vi.fn());

        openActions();
        fireEvent.click(
            await screen.findByRole("menuitem", { name: "Open side panel" }),
        );
        fireEvent.click(
            await screen.findByRole("button", { name: "Open Documents" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Pick Budget.xlsx" }),
        );

        const viewer = await screen.findByTestId("spreadsheet-viewer");
        expect(viewer).toHaveAttribute("data-document-id", "excel-1");
        // The placeholder gives way; only the tab bar's + keeps the name.
        expect(screen.queryByText("Open Documents")).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Pick Budget.xlsx" }),
        ).not.toBeInTheDocument();
    });

    it("keeps the panel open on its placeholder when the last tab closes", async () => {
        renderView();

        fireEvent.click(
            screen.getByRole("button", { name: "Open Budget.xlsx" }),
        );
        await screen.findByTestId("spreadsheet-viewer");
        fireEvent.click(
            screen.getByRole("button", { name: "Close Budget.xlsx" }),
        );

        expect(
            await screen.findByRole("button", { name: "Open Documents" }),
        ).toBeInTheDocument();
        expect(
            screen.queryByTestId("spreadsheet-viewer"),
        ).not.toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Close panel" }),
        ).toBeInTheDocument();
    });

    it("opens the picker from the + after the last tab", async () => {
        renderView();

        fireEvent.click(
            screen.getByRole("button", { name: "Open Budget.xlsx" }),
        );
        await screen.findByTestId("spreadsheet-viewer");
        expect(
            screen.queryByRole("button", { name: "Pick Budget.xlsx" }),
        ).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Open Documents" }));
        expect(
            screen.getByRole("button", { name: "Pick Budget.xlsx" }),
        ).toBeInTheDocument();
    });

    it("edits quick actions from the menu", async () => {
        renderView();

        openActions();
        fireEvent.click(
            await screen.findByRole("menuitem", { name: "Edit quick actions" }),
        );
        expect(screen.getByText("Quick actions modal")).toBeInTheDocument();
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
                onNewChat={vi.fn()}
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
                onNewChat={vi.fn()}
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
                    onNewChat={vi.fn()}
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
                    onNewChat={vi.fn()}
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
            fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
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

    it("asks before deletion and cancellation preserves the file", async () => {
        renderView();
        fireEvent.click(screen.getByRole("button", { name: "Open Budget.xlsx" }));
        fireEvent.contextMenu(await screen.findByRole("tab", { name: "Budget.xlsx" }));
        fireEvent.click(await screen.findByRole("menuitem", { name: "Delete file" }));
        expect(screen.getByRole("dialog", { name: "Delete file?" })).toBeVisible();
        expect(deleteDocument).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.getByRole("tab", { name: "Budget.xlsx" })).toBeVisible();
        expect(deleteDocument).not.toHaveBeenCalled();
    });

    it("hides destructive actions when the document is read-only", async () => {
        vi.mocked(getDocument).mockResolvedValue({ ...spreadsheet, can_edit: false, can_delete: false });
        renderView();
        fireEvent.click(screen.getByRole("button", { name: "Open Budget.xlsx" }));
        await waitFor(() => expect(getDocument).toHaveBeenCalled());
        fireEvent.contextMenu(await screen.findByRole("tab", { name: "Budget.xlsx" }));
        expect(screen.queryByRole("menuitem", { name: "Delete file" })).toBeNull();
        expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
        expect(deleteDocument).not.toHaveBeenCalled();
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
        fireEvent.click(await screen.findByRole("menuitem", { name: "Delete file" }));
        fireEvent.click(screen.getByRole("button", { name: "Delete file" }));
        expect(
            await screen.findByText(
                "This file could not be deleted. Please try again.",
            ),
        ).toBeVisible();
        expect(screen.getByRole("tab", { name: "Budget.xlsx" })).toBeVisible();
        fireEvent.click(
            screen.getByRole("button", { name: "Dismiss warning" }),
        );
        fireEvent.contextMenu(screen.getByRole("tab", { name: "Budget.xlsx" }));
        fireEvent.click(await screen.findByRole("menuitem", { name: "Delete file" }));
        fireEvent.click(screen.getByRole("button", { name: "Delete file" }));
        await waitFor(() =>
            expect(
                screen.queryByRole("tab", { name: "Budget.xlsx" }),
            ).toBeNull(),
        );
        expect(deleteDocument).toHaveBeenCalledWith("excel-1");
    });
});
