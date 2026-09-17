import { StrictMode, Suspense, type ReactNode } from "react";
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
import { getProject } from "@/app/lib/mikeApi";

const state = vi.hoisted(() => ({
    attachmentFilename: "Budget.xlsx",
    replace: vi.fn(),
    push: vi.fn(),
    getChat: vi.fn(),
    getDocument: vi.fn(),
    uploadProjectDocuments: vi.fn(),
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
    getDocument: state.getDocument,
    uploadProjectDocuments: state.uploadProjectDocuments,
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
        chatModel,
        chatReasoningLevel,
        onDocumentClick,
    }: {
        onSubmit: (message: Message) => void;
        canSend: boolean;
        chatKey: string;
        isLoading: boolean;
        chatModel?: string | null;
        chatReasoningLevel?: Message["reasoning"] | null;
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
                    onSubmit({ role: "user", content: "First question", model: "gpt-5.6-sol", reasoning: "xhigh" })
                }
                data-chat-key={chatKey}
                data-chat-model={chatModel}
                data-chat-reasoning={chatReasoningLevel}
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
    state.getDocument.mockReset();
    state.uploadProjectDocuments.mockReset();
    state.chats = [];
    state.attachmentFilename = "Budget.xlsx";
    state.projectChats = [];
    state.loadChats.mockResolvedValue(undefined);
    window.history.replaceState(null, "", "/projects/p1/assistant/chat");
});

async function renderWorkspace(canSend = true, strict = false) {
    const params = Promise.resolve({ id: "p1" });
    await act(async () => {
        const workspace = (
            <Suspense fallback="Loading">
                <ProjectAssistantChatPage params={params} />
            </Suspense>
        );
        render(strict ? <StrictMode>{workspace}</StrictMode> : workspace);
    });
    await waitFor(() => {
        const button = screen.getByRole("button", { name: "Send question" });
        if (canSend) expect(button).toBeEnabled();
        else expect(button).toBeDisabled();
    });
}

describe("closing document tabs", () => {
    it("selects the next tab, then the previous tab, then clears the viewer in StrictMode", async () => {
        await renderWorkspace(true, true);
        fireEvent.click(screen.getByRole("button", { name: "Open draft" }));
        fireEvent.click(
            screen.getByRole("button", { name: "Open attached Excel" }),
        );
        state.getDocument.mockResolvedValueOnce({
            id: "notes",
            filename: "Notes.docx",
            file_type: "docx",
        });
        fireEvent.drop(screen.getByRole("region", { name: "Document viewer" }), {
            dataTransfer: {
                types: ["application/mike-doc"],
                getData: () => "notes",
            },
        });
        await screen.findByRole("tab", { name: /Notes.docx/ });
        fireEvent.click(screen.getByRole("tab", { name: /Budget.xlsx/ }));
        fireEvent.click(screen.getByRole("button", { name: "Close Budget.xlsx" }));
        expect(screen.getByRole("tab", { name: /Notes.docx/ })).toHaveAttribute(
            "aria-selected", "true",
        );
        fireEvent.click(screen.getByRole("button", { name: "Close Notes.docx" }));
        expect(screen.getByRole("tab", { name: /Draft.docx/ })).toHaveAttribute(
            "aria-selected", "true",
        );
        fireEvent.click(screen.getByRole("button", { name: "Close Draft.docx" }));
        expect(screen.queryAllByRole("tab")).toHaveLength(0);
        expect(screen.queryByText("Draft viewer")).toBeNull();
    });

    it("keeps the active document selected when an inactive tab closes", async () => {
        await renderWorkspace(true, true);
        fireEvent.click(screen.getByRole("button", { name: "Open draft" }));
        fireEvent.click(
            screen.getByRole("button", { name: "Open attached Excel" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Close Draft.docx" }));
        expect(screen.getByRole("tab", { name: /Budget.xlsx/ })).toHaveAttribute(
            "aria-selected", "true",
        );
        expect(screen.getByTestId("excel-viewer")).toBeVisible();
    });
});

describe("document viewer drops", () => {
    it("opens project documents from a drop and reuses their tabs", async () => {
        await renderWorkspace();
        const viewer = screen.getByRole("region", { name: "Document viewer" });
        const dataTransfer = {
            types: ["application/mike-doc"],
            getData: vi.fn((type) =>
                type === "application/mike-doc" ? "doc1" : "",
            ),
        };
        fireEvent.dragOver(viewer, { dataTransfer });
        expect(screen.getByText("Drop files here to open")).toBeVisible();
        fireEvent.drop(viewer, { dataTransfer });
        const original = await screen.findByText("Draft viewer");
        fireEvent.drop(viewer, { dataTransfer });
        await waitFor(() =>
            expect(screen.getAllByText("Draft viewer")).toHaveLength(1),
        );
        expect(screen.getByText("Draft viewer")).toBe(original);
        expect(screen.queryByText("Drop files here to open")).toBeNull();
        expect(state.getDocument).not.toHaveBeenCalled();
        expect(state.uploadProjectDocuments).not.toHaveBeenCalled();
    });

    it("opens all documents from a multi-row drop without adding existing files to the project", async () => {
        state.getDocument.mockResolvedValueOnce({
            id: "excel",
            filename: "Budget.xlsx",
            file_type: "xlsx",
        });
        await renderWorkspace();
        fireEvent.drop(
            screen.getByRole("region", { name: "Document viewer" }),
            {
                dataTransfer: {
                    types: ["application/mike-docs"],
                    getData: (type: string) =>
                        type === "application/mike-docs"
                            ? JSON.stringify(["doc1", "excel"])
                            : "",
                },
            },
        );
        expect(await screen.findByTestId("excel-viewer")).toHaveAttribute(
            "data-document-id",
            "excel",
        );
        expect(screen.getByText("Draft viewer")).toBeInTheDocument();
        expect(state.getDocument).toHaveBeenCalledWith("excel");
        expect(state.uploadProjectDocuments).not.toHaveBeenCalled();
    });

    it("uploads external files through the project flow and opens the result", async () => {
        state.uploadProjectDocuments.mockResolvedValueOnce([
            {
                status: "completed",
                result: {
                    id: "uploaded-excel",
                    filename: "Budget.xlsx",
                    file_type: "xlsx",
                    status: "ready",
                },
            },
        ]);
        await renderWorkspace();
        const file = new File(["data"], "Budget.xlsx");
        fireEvent.drop(
            screen.getByRole("region", { name: "Document viewer" }),
            {
                dataTransfer: {
                    types: ["Files"],
                    files: [file],
                    items: [],
                    getData: () => "",
                },
            },
        );
        expect(await screen.findByTestId("excel-viewer")).toHaveAttribute(
            "data-document-id",
            "uploaded-excel",
        );
        expect(state.uploadProjectDocuments).toHaveBeenCalledWith(
            "p1",
            [expect.objectContaining({ file, folderId: null })],
            expect.any(Object),
        );
    });

    it("keeps the upload permission boundary for read-only projects", async () => {
        vi.mocked(getProject).mockResolvedValueOnce({
            id: "p1",
            name: "Matter",
            access_role: "viewer",
            user_id: "owner",
            cm_number: null,
            practice: null,
            memory_enabled: false,
            created_at: "2026-09-15T00:00:00Z",
            updated_at: "2026-09-15T00:00:00Z",
            documents: [],
            folders: [],
        });
        await renderWorkspace(false);
        fireEvent.drop(
            screen.getByRole("region", { name: "Document viewer" }),
            {
                dataTransfer: {
                    types: ["Files"],
                    files: [new File(["data"], "Budget.xlsx")],
                    items: [],
                    getData: () => "",
                },
            },
        );
        await screen.findByText(/upload documents to this project/);
        expect(state.uploadProjectDocuments).not.toHaveBeenCalled();
    });

    it("maps failed document loads to a user-facing error", async () => {
        state.getDocument.mockRejectedValueOnce(
            new Error("internal database stack"),
        );
        await renderWorkspace();
        fireEvent.drop(
            screen.getByRole("region", { name: "Document viewer" }),
            {
                dataTransfer: {
                    types: ["application/mike-doc"],
                    getData: (type: string) =>
                        type === "application/mike-doc" ? "missing" : "",
                },
            },
        );
        expect(
            await screen.findByText(
                "These files could not be opened. Please try again.",
            ),
        ).toBeVisible();
        expect(screen.queryByText("internal database stack")).toBeNull();
    });

    it("ignores folder and tab-reorder drags", async () => {
        await renderWorkspace();
        const viewer = screen.getByRole("region", { name: "Document viewer" });
        for (const type of [
            "application/mike-folder",
            "application/mike-project-tab",
        ]) {
            const dataTransfer = { types: [type], getData: vi.fn() };
            expect(fireEvent.dragOver(viewer, { dataTransfer })).toBe(true);
            fireEvent.drop(viewer, { dataTransfer });
            expect(dataTransfer.getData).not.toHaveBeenCalled();
        }
        expect(screen.queryByText("Drop files here to open")).toBeNull();
        expect(state.uploadProjectDocuments).not.toHaveBeenCalled();
    });
});

describe("project chat workspace lifecycle", () => {
    it("updates the URL before the first response arrives while preserving the workspace and live stream", async () => {
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        const encoder = new TextEncoder();
        state.streamProjectChat.mockResolvedValue(
            new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                    stream = controller;
                },
            })),
        );
        await renderWorkspace();
        fireEvent.click(screen.getByRole("button", { name: "Open draft" }));
        const panel = screen.getByRole("tabpanel", { name: "Draft.docx" });
        const viewer = screen.getByText("Draft viewer");
        fireEvent.click(screen.getByTitle("Collapse explorer"));
        fireEvent.click(screen.getByRole("button", { name: "Send question" }));
        await waitFor(() => expect(state.streamProjectChat).toHaveBeenCalled());
        act(() => {
            stream.enqueue(encoder.encode('data: {"type":"chat_id","chatId":"created-chat"}\n\n'));
        });
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Send question" }),
            ).toHaveAttribute("data-chat-key", "created-chat"),
        );
        expect(screen.queryByText("First answer")).not.toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole("button", { name: "Send question" })).toHaveAttribute("data-chat-model", "gpt-5.6-sol"));
        expect(screen.getByRole("button", { name: "Send question" })).toHaveAttribute("data-chat-reasoning", "xhigh");
        expect(screen.getByRole("button", { name: "Send question" })).toBeDisabled();
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
        act(() => {
            stream.enqueue(encoder.encode('data: {"type":"content_delta","text":"First answer"}\n\n'));
        });
        await waitFor(() => expect(screen.getByText("First answer")).toBeVisible());
        expect(screen.getByRole("button", { name: "Send question" })).toBeDisabled();
        act(() => stream.close());
        await waitFor(() => expect(screen.getByRole("button", { name: "Send question" })).not.toBeDisabled());
        expect(screen.getByRole("tabpanel", { name: "Draft.docx" })).toBe(panel);
        expect(state.getChat).not.toHaveBeenCalled();
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
