import { Suspense, type ReactNode } from "react";
import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
    AssistantEvent,
    Document,
    Message,
} from "@/app/components/shared/types";
import ProjectAssistantChatPage from "./page";

const state = vi.hoisted(() => ({
    attachmentFilename: "Budget.xlsx",
    replace: vi.fn(),
    push: vi.fn(),
    getChat: vi.fn(),
    loadChats: vi.fn().mockResolvedValue(undefined),
    setCurrentChatId: vi.fn(),
    setNewChatMessages: vi.fn(),
    streamProjectChat: vi.fn(),
    projectChats: [] as Array<{
        id: string;
        project_id: string;
        title: string;
        created_at: string;
    }>,
    chats: [] as Array<{
        id: string;
        project_id: string;
        title: string;
        created_at: string;
    }>,
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace: state.replace, push: state.push }),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    getProject: vi.fn().mockResolvedValue({
        id: "p1",
        name: "Matter",
        access_role: "owner",
        documents: [{ id: "doc1", filename: "Draft.docx" }],
        folders: [],
    }),
    getChat: state.getChat,
    listProjectChats: vi
        .fn()
        .mockImplementation(async () => state.projectChats),
    streamProjectChat: state.streamProjectChat,
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        setCurrentChatId: state.setCurrentChatId,
        setNewChatMessages: state.setNewChatMessages,
        newChatMessages: null,
        chats: state.chats,
        renameChat: vi.fn(),
        replaceChatId: vi.fn(),
        loadChats: state.loadChats,
        saveChat: vi.fn(),
        updateChatTitle: vi.fn(),
    }),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "u1" } }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: { displayName: "User" } }),
}));
vi.mock("@/app/contexts/SidebarContext", () => ({
    useSidebar: () => ({ setSidebarOpen: vi.fn() }),
}));
vi.mock("@/app/hooks/useAssistantMessageLayout", () => ({
    useAssistantMessageLayout: () => ({
        minHeight: "100px",
        scrollLatestUserToTop: vi.fn(),
    }),
}));
vi.mock("@/app/components/projects/ProjectExplorer", () => ({
    ProjectExplorer: ({
        documents,
        onDocClick,
    }: {
        documents: Document[];
        onDocClick: (doc: Document) => void;
    }) => <button onClick={() => onDocClick(documents[0])}>Open draft</button>,
}));
vi.mock("@/app/components/assistant/ChatInput", () => ({
    ChatInput: ({
        onSubmit,
        canSend,
        chatKey,
        isLoading,
        onDocumentClick,
    }: {
        onSubmit: (message: Message) => void;
        canSend: boolean;
        chatKey: string;
        isLoading: boolean;
        onDocumentClick: (document: Document) => void;
    }) => (
        <>
            <button
                onClick={() =>
                    onDocumentClick({
                        id: "excel-attachment",
                        filename: state.attachmentFilename,
                        file_type: "xlsx",
                    } as Document)
                }
            >
                Open attached Excel
            </button>
            <button
                disabled={!canSend || isLoading}
                onClick={() =>
                    onSubmit({ role: "user", content: "First question" })
                }
                data-chat-key={chatKey}
            >
                Send question
            </button>
        </>
    ),
}));
vi.mock("@/app/components/assistant/ChatInputPrompt", () => ({
    ChatInputPrompt: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/app/components/assistant/UserMessage", () => ({
    UserMessage: ({ content }: { content: string }) => <p>{content}</p>,
}));
vi.mock("@/app/components/assistant/AssistantMessage", () => ({
    AssistantMessage: ({ events }: { events: AssistantEvent[] }) => (
        <p>
            {events
                ?.map((event) => ("text" in event ? event.text : ""))
                .join("")}
        </p>
    ),
}));
vi.mock("@/app/components/shared/views/DocxView", () => ({
    DocxView: () => <div>Draft viewer</div>,
}));
vi.mock("@/app/components/shared/views/PdfView", () => ({
    PdfView: () => null,
}));
vi.mock("@/app/components/shared/views/SpreadsheetView", () => ({
    SpreadsheetView: ({ documentId }: { documentId: string }) => (
        <div data-testid="excel-viewer" data-document-id={documentId} />
    ),
}));
vi.mock("@/app/components/modals/AddDocumentsModal", () => ({
    AddDocumentsModal: () => null,
}));
vi.mock("@/app/components/modals/ProjectPickerModal", () => ({
    ProjectPickerModal: () => null,
}));
vi.mock("@/app/components/projects/ProjectMemoryModal", () => ({
    ProjectMemoryModal: () => null,
}));
vi.mock("@/app/components/projects/ProjectWorkspaceTips", () => ({
    ProjectWorkspaceTips: () => null,
}));

beforeEach(() => {
    vi.clearAllMocks();
    state.chats = [];
    state.attachmentFilename = "Budget.xlsx";
    state.projectChats = [];
    state.loadChats.mockResolvedValue(undefined);
    window.history.replaceState(null, "", "/projects/p1/assistant/chat");
});

async function renderWorkspace() {
    const params = Promise.resolve({ id: "p1" });
    await act(async () => {
        render(
            <Suspense fallback="Loading">
                <ProjectAssistantChatPage params={params} />
            </Suspense>,
        );
    });
    await waitFor(() =>
        expect(
            screen.getByRole("button", { name: "Send question" }),
        ).toBeEnabled(),
    );
}

function response(text: string, chatId: string) {
    return new Response(
        new ReadableStream({
            start(controller) {
                controller.enqueue(
                    new TextEncoder().encode(
                        `data: ${JSON.stringify({ type: "chat_id", chatId })}\n\ndata: ${JSON.stringify({ type: "content_delta", text })}\n\n`,
                    ),
                );
                controller.close();
            },
        }),
    );
}

describe("project chat workspace lifecycle", () => {
    it("keeps the first response, open document and collapsed explorer while adopting the server chat id", async () => {
        let finishHistory!: () => void;
        state.loadChats.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finishHistory = resolve;
                }),
        );
        state.streamProjectChat.mockResolvedValue(
            response("First answer", "created-chat"),
        );
        await renderWorkspace();
        fireEvent.click(screen.getByRole("button", { name: "Open draft" }));
        const panel = screen.getByRole("tabpanel", { name: "Draft.docx" });
        const viewer = screen.getByText("Draft viewer");
        fireEvent.click(screen.getByTitle("Collapse explorer"));
        fireEvent.click(screen.getByRole("button", { name: "Send question" }));
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Send question" }),
            ).toHaveAttribute("data-chat-key", "created-chat"),
        );
        expect(screen.getByText("First answer")).toBeVisible();
        expect(screen.getByText("First question")).toBeVisible();
        expect(screen.getByRole("tabpanel", { name: "Draft.docx" })).toBe(
            panel,
        );
        expect(screen.getByText("Draft viewer")).toBe(viewer);
        expect(screen.getByTitle("Expand explorer")).toBeVisible();
        expect(state.getChat).not.toHaveBeenCalled();
        expect(state.replace).not.toHaveBeenCalled();
        expect(window.location.pathname).toBe(
            "/projects/p1/assistant/chat/created-chat",
        );
        await act(async () => {
            finishHistory();
        });
    });

    it("lists project chats newest first after merging both history sources", async () => {
        state.chats = [
            {
                id: "older",
                project_id: "p1",
                title: "Older",
                created_at: "2026-09-10T00:00:00Z",
            },
            {
                id: "newer",
                project_id: "p1",
                title: "Newer",
                created_at: "2026-09-14T00:00:00Z",
            },
        ];
        state.projectChats = [
            {
                id: "latest",
                project_id: "p1",
                title: "Latest",
                created_at: "2026-09-15T00:00:00Z",
            },
        ];
        await renderWorkspace();
        fireEvent.click(screen.getByRole("button", { name: "New Chat" }));
        const rows = await screen.findAllByRole("menuitem");
        expect(rows.map((row) => row.textContent)).toEqual([
            expect.stringContaining("Latest"),
            expect.stringContaining("Newer"),
            expect.stringContaining("Older"),
        ]);
    });
});

it.each(["Budget.xlsx", "Budget"])(
    "opens direct Excel attachment %s in the IDE document viewer",
    async (filename) => {
        state.attachmentFilename = filename;
        await renderWorkspace();
        fireEvent.click(
            screen.getByRole("button", { name: "Open attached Excel" }),
        );
        const panel = screen.getByRole("tabpanel", { name: filename });
        expect(panel).toContainElement(screen.getByTestId("excel-viewer"));
        expect(screen.getByTestId("excel-viewer")).toHaveAttribute(
            "data-document-id",
            "excel-attachment",
        );
        expect(screen.getByRole("tab", { name: filename })).toHaveAttribute(
            "aria-selected",
            "true",
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Open attached Excel" }),
        );
        expect(screen.getAllByTestId("excel-viewer")).toHaveLength(1);
    },
);
