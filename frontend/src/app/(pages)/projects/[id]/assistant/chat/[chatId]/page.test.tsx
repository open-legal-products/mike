import { StrictMode, Suspense, type ReactNode } from "react";
import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
    AssistantEvent,
    Citation,
    Document,
    Message,
} from "@/app/components/shared/types";
import ProjectAssistantChatPage from "./page";
import { getProject, moveDocumentToFolder } from "@/app/lib/mikeApi";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";

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
        updated_at?: string;
    }>,
    chats: [] as Array<{
        id: string;
        project_id: string;
        title: string;
        created_at: string;
        updated_at?: string;
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
    moveDocumentToFolder: vi.fn(),
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
    useAuth: () => ({ user: { id: "u1" }, authLoading: false }),
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
        onMoveDoc,
    }: {
        documents: Document[];
        onDocClick: (doc: Document) => void;
        onMoveDoc?: (
            docId: string,
            targetFolderId: string | null,
        ) => Promise<void>;
    }) => (
        <>
            <button onClick={() => onDocClick(documents[0])}>Open draft</button>
            <button onClick={() => void onMoveDoc?.("doc1", "folder-1")}>
                Move draft
            </button>
            <span data-testid="draft-folder">
                {documents.find((doc) => doc.id === "doc1")?.folder_id ??
                    "root"}
            </span>
        </>
    ),
}));
vi.mock("@/app/components/assistant/ChatInput", () => ({
    ChatInput: ({
        onSubmit,
        canSend,
        chatLoading,
        chatKey,
        isLoading,
        chatModel,
        chatReasoningLevel,
        onDocumentClick,
    }: {
        onSubmit: (message: Message) => void;
        canSend: boolean;
        chatLoading?: boolean;
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
                disabled={!canSend || !!chatLoading || isLoading}
                onClick={() =>
                    onSubmit({
                        role: "user",
                        content: "First question",
                        model: "gpt-5.6-sol",
                        reasoning: "xhigh",
                    })
                }
                data-can-send={String(canSend)}
                data-chat-loading={String(!!chatLoading)}
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
    AssistantMessage: ({
        events,
        citations,
        activeCitation,
        onCitationClick,
    }: {
        events: AssistantEvent[];
        citations?: Citation[];
        activeCitation?: Citation | null;
        onCitationClick?: (citation: Citation) => void;
    }) => (
        <div>
            {events
                ?.map((event) => ("text" in event ? event.text : ""))
                .join("")}
            {citations?.[0] && (
                <button
                    type="button"
                    data-active={String(activeCitation === citations[0])}
                    onClick={() => onCitationClick?.(citations[0])}
                >
                    Citation pill {citations[0].ref}
                </button>
            )}
        </div>
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
                <ToastViewportUI />
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
        fireEvent.drop(
            screen.getByRole("region", { name: "Document viewer" }),
            {
                dataTransfer: {
                    types: ["application/mike-doc"],
                    getData: () => "notes",
                },
            },
        );
        await screen.findByRole("tab", { name: /Notes.docx/ });
        fireEvent.click(screen.getByRole("tab", { name: /Budget.xlsx/ }));
        fireEvent.click(
            screen.getByRole("button", { name: "Close Budget.xlsx" }),
        );
        expect(screen.getByRole("tab", { name: /Notes.docx/ })).toHaveAttribute(
            "aria-selected",
            "true",
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Close Notes.docx" }),
        );
        expect(screen.getByRole("tab", { name: /Draft.docx/ })).toHaveAttribute(
            "aria-selected",
            "true",
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Close Draft.docx" }),
        );
        expect(screen.queryAllByRole("tab")).toHaveLength(0);
        expect(screen.queryByText("Draft viewer")).toBeNull();
    });

    it("keeps the active document selected when an inactive tab closes", async () => {
        await renderWorkspace(true, true);
        fireEvent.click(screen.getByRole("button", { name: "Open draft" }));
        fireEvent.click(
            screen.getByRole("button", { name: "Open attached Excel" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Close Draft.docx" }),
        );
        expect(
            screen.getByRole("tab", { name: /Budget.xlsx/ }),
        ).toHaveAttribute("aria-selected", "true");
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
    it("marks the selected citation pill active until a regular document view opens", async () => {
        const citation: Citation = {
            type: "citation_data",
            ref: 1,
            doc_id: "doc1",
            document_id: "doc1",
            filename: "Draft.docx",
            page: 1,
            quote: "Relevant language",
        };
        state.getChat.mockResolvedValueOnce({
            chat: {
                id: "c1",
                project_id: "p1",
                title: "Existing chat",
                user_id: "u1",
                created_at: "2026-09-15T00:00:00Z",
            },
            messages: [
                {
                    role: "assistant",
                    content: "Answer",
                    events: [{ type: "content", text: "Answer" }],
                    citations: [citation],
                },
            ],
        });

        await act(async () => {
            render(
                <Suspense fallback="Loading">
                    <ProjectAssistantChatPage
                        params={Promise.resolve({ id: "p1", chatId: "c1" })}
                    />
                </Suspense>,
            );
        });

        const pill = await screen.findByRole("button", {
            name: "Citation pill 1",
        });
        expect(pill).toHaveAttribute("data-active", "false");
        fireEvent.click(pill);
        expect(pill).toHaveAttribute("data-active", "true");

        fireEvent.click(screen.getByRole("button", { name: "Open draft" }));
        expect(pill).toHaveAttribute("data-active", "false");
    });

    it("hides the composer until the chat and project access both resolve", async () => {
        let resolveChat!: (loaded: {
            chat: Record<string, unknown>;
            messages: Message[];
        }) => void;
        state.getChat.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveChat = resolve;
                }),
        );
        let resolveProject!: (
            project: Awaited<ReturnType<typeof getProject>>,
        ) => void;
        vi.mocked(getProject).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveProject = resolve;
                }),
        );

        await act(async () => {
            render(
                <Suspense fallback="Loading">
                    <ProjectAssistantChatPage
                        params={Promise.resolve({ id: "p1", chatId: "c1" })}
                    />
                </Suspense>,
            );
        });

        expect(
            screen.queryByRole("button", { name: "Send question" }),
        ).toBeNull();

        await act(async () => {
            resolveChat({
                chat: {
                    id: "c1",
                    project_id: "p1",
                    title: "Existing chat",
                    user_id: "u2",
                    created_at: "2026-09-15T00:00:00Z",
                },
                messages: [],
            });
        });

        // The chat is here but the project role is not, so the composer must
        // stay away rather than guess with the read-only placeholder.
        expect(
            screen.queryByRole("button", { name: "Send question" }),
        ).toBeNull();

        await act(async () => {
            resolveProject({
                id: "p1",
                name: "Matter",
                access_role: "owner",
                user_id: "u1",
                cm_number: null,
                practice: null,
                memory_enabled: false,
                created_at: "2026-09-15T00:00:00Z",
                updated_at: "2026-09-15T00:00:00Z",
                documents: [],
                folders: [],
            });
        });

        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Send question" }),
            ).toBeEnabled(),
        );
    });

    it("updates the URL before the first response arrives while preserving the workspace and live stream", async () => {
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        const encoder = new TextEncoder();
        state.streamProjectChat.mockResolvedValue(
            new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        stream = controller;
                    },
                }),
            ),
        );
        await renderWorkspace();
        fireEvent.click(screen.getByRole("button", { name: "Open draft" }));
        const panel = screen.getByRole("tabpanel", { name: "Draft.docx" });
        const viewer = screen.getByText("Draft viewer");
        fireEvent.click(screen.getByTitle("Collapse explorer"));
        fireEvent.click(screen.getByRole("button", { name: "Send question" }));
        await waitFor(() => expect(state.streamProjectChat).toHaveBeenCalled());
        act(() => {
            stream.enqueue(
                encoder.encode(
                    'data: {"type":"chat_id","chatId":"created-chat"}\n\n',
                ),
            );
        });
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Send question" }),
            ).toHaveAttribute("data-chat-key", "created-chat"),
        );
        expect(screen.queryByText("First answer")).not.toBeInTheDocument();
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Send question" }),
            ).toHaveAttribute("data-chat-model", "gpt-5.6-sol"),
        );
        expect(
            screen.getByRole("button", { name: "Send question" }),
        ).toHaveAttribute("data-chat-reasoning", "xhigh");
        expect(
            screen.getByRole("button", { name: "Send question" }),
        ).toBeDisabled();
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
            stream.enqueue(
                encoder.encode(
                    'data: {"type":"content_delta","text":"First answer"}\n\n',
                ),
            );
        });
        await waitFor(() =>
            expect(screen.getByText("First answer")).toBeVisible(),
        );
        expect(
            screen.getByRole("button", { name: "Send question" }),
        ).toBeDisabled();
        act(() => stream.close());
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Send question" }),
            ).not.toBeDisabled(),
        );
        expect(screen.getByRole("tabpanel", { name: "Draft.docx" })).toBe(
            panel,
        );
        expect(state.getChat).not.toHaveBeenCalled();
    });

    it("lists project chats by latest activity after merging both history sources", async () => {
        state.chats = [
            {
                id: "older",
                project_id: "p1",
                title: "Older",
                created_at: "2026-09-10T00:00:00Z",
                updated_at: "2026-09-20T00:00:00Z",
            },
            {
                id: "newer",
                project_id: "p1",
                title: "Newer",
                created_at: "2026-09-14T00:00:00Z",
                updated_at: "2026-09-14T00:00:00Z",
            },
            {
                id: "latest",
                project_id: "p1",
                title: "Stale latest",
                created_at: "2026-09-15T00:00:00Z",
                updated_at: "2026-09-13T00:00:00Z",
            },
        ];
        state.projectChats = [
            {
                id: "latest",
                project_id: "p1",
                title: "Latest",
                created_at: "2026-09-15T00:00:00Z",
                updated_at: "2026-09-15T00:00:00Z",
            },
        ];
        await renderWorkspace();
        fireEvent.click(screen.getByRole("button", { name: "New Chat" }));
        const rows = await screen.findAllByRole("menuitem");
        expect(rows.map((row) => row.textContent)).toEqual([
            expect.stringContaining("Older"),
            expect.stringContaining("Latest"),
            expect.stringContaining("Newer"),
        ]);
        expect(screen.queryByText("Stale latest")).not.toBeInTheDocument();
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

describe("leaving a project chat mid-stream", () => {
    /**
     * A response body that reports whether the page cancelled its reader.
     * Cancelling closes the socket, and the backend reads a closed socket as
     * Stop: it persists a truncated "Cancelled by user." answer.
     */
    function controllableStream() {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const state = { cancelled: false };
        const encoder = new TextEncoder();
        const response = new Response(
            new ReadableStream<Uint8Array>({
                start(c) {
                    controller = c;
                },
                cancel() {
                    state.cancelled = true;
                },
            }),
        );
        return {
            response,
            state,
            send: (frame: string) =>
                act(() => controller.enqueue(encoder.encode(frame))),
            close: () => act(() => controller.close()),
        };
    }

    const requestSignal = () =>
        (state.streamProjectChat.mock.calls[0][0] as { signal: AbortSignal })
            .signal;

    beforeEach(() => {
        state.chats = [
            {
                id: "other",
                project_id: "p1",
                title: "Other thread",
                created_at: "2026-09-14T00:00:00Z",
            },
        ];
        state.getChat.mockResolvedValue({
            chat: {
                id: "other",
                title: "Other thread",
                user_id: "u1",
                model: null,
                reasoning_level: null,
            },
            messages: [],
        });
    });

    it("switching to another chat detaches the stream instead of aborting it", async () => {
        const body = controllableStream();
        state.streamProjectChat.mockResolvedValue(body.response);
        await renderWorkspace();
        fireEvent.click(screen.getByRole("button", { name: "Send question" }));
        await waitFor(() => expect(state.streamProjectChat).toHaveBeenCalled());
        await body.send('data: {"type":"chat_id","chatId":"created-chat"}\n\n');
        await body.send(
            'data: {"type":"content_delta","text":"First answer"}\n\n',
        );
        await waitFor(() =>
            expect(screen.getByText("First answer")).toBeVisible(),
        );
        state.chats.push({
            id: "created-chat",
            project_id: "p1",
            title: "Original thread",
            created_at: "2026-09-14T00:00:00Z",
            updated_at: "2026-09-14T00:00:00Z",
        });

        fireEvent.click(screen.getByRole("button", { name: "New Chat" }));
        fireEvent.click(
            (await screen.findAllByRole("menuitem")).find((row) =>
                row.textContent?.includes("Other thread"),
            )!,
        );
        await waitFor(() =>
            expect(window.location.pathname).toBe(
                "/projects/p1/assistant/chat/other",
            ),
        );

        // The thread the user left keeps its request: not aborted, reader not
        // cancelled, so the server finishes and persists the whole answer.
        expect(requestSignal().aborted).toBe(false);
        expect(body.state.cancelled).toBe(false);
        await body.send(
            'data: {"type":"content_delta","text":" and the rest"}\n\n',
        );
        await body.close();
        expect(body.state.cancelled).toBe(false);
        fireEvent.click(screen.getByRole("button", { name: "Other thread" }));
        const completedRow = (await screen.findAllByRole("menuitem")).find(
            (row) => row.textContent?.includes("Original thread"),
        )!;
        await waitFor(() =>
            expect(
                completedRow.querySelector("img[aria-hidden='true']"),
            ).toHaveClass("hue-rotate-[285deg]"),
        );
        // ...and nothing from it lands in the thread now on screen.
        expect(screen.queryByText(/and the rest/)).not.toBeInTheDocument();
        expect(screen.queryByText(/Cancelled by user/)).not.toBeInTheDocument();
    });

    it("shows the answer streaming when returning before a detached turn finishes", async () => {
        const body = controllableStream();
        state.streamProjectChat.mockResolvedValue(body.response);
        await renderWorkspace();
        fireEvent.click(screen.getByRole("button", { name: "Send question" }));
        await waitFor(() => expect(state.streamProjectChat).toHaveBeenCalled());
        await body.send(
            'data: {"type":"chat_id","chatId":"created-chat","assistantMessageId":"answer-1"}\n\n',
        );
        await body.send(
            'data: {"type":"content_delta","text":"First answer"}\n\n',
        );
        await screen.findByText("First answer");
        state.chats.push({
            id: "created-chat",
            project_id: "p1",
            title: "Original thread",
            created_at: "2026-09-14T00:00:00Z",
        });
        fireEvent.click(screen.getByRole("button", { name: "New Chat" }));
        fireEvent.click(
            (await screen.findAllByRole("menuitem")).find((row) =>
                row.textContent?.includes("Other thread"),
            )!,
        );
        await waitFor(() =>
            expect(state.getChat).toHaveBeenCalledWith("other"),
        );
        await screen.findByRole("button", { name: "Send question" });
        expect(screen.queryByText(/First answer/)).not.toBeInTheDocument();
        // The answer keeps arriving while nobody is looking at its thread.
        await body.send(
            'data: {"type":"content_delta","text":" continues"}\n\n',
        );

        // What the server holds for that thread right now: the question is
        // stored, the assistant row is hidden until it has content.
        const otherHistory = await state.getChat.mock.results[0].value;
        let finishHistory!: (value: unknown) => void;
        state.getChat.mockImplementation((id: string) =>
            id === "created-chat"
                ? new Promise((resolve) => {
                      finishHistory = resolve;
                  })
                : Promise.resolve(otherHistory),
        );
        fireEvent.click(screen.getByRole("button", { name: "Other thread" }));
        fireEvent.click(
            (await screen.findAllByRole("menuitem")).find((row) =>
                row.textContent?.includes("Original thread"),
            )!,
        );
        await waitFor(() =>
            expect(window.location.pathname).toBe(
                "/projects/p1/assistant/chat/created-chat",
            ),
        );
        // The history is requested at once instead of after the stream ends.
        await waitFor(() =>
            expect(state.getChat).toHaveBeenCalledWith("created-chat"),
        );
        await act(async () =>
            finishHistory({
                chat: {
                    id: "created-chat",
                    title: "New Chat",
                    user_id: "u1",
                    model: null,
                    reasoning_level: null,
                },
                messages: [
                    { id: "u1", role: "user", content: "First question" },
                ],
            }),
        );
        // The transcript shows the stored question once and the answer as far
        // as it has got, with the composer on the page in its streaming state
        // (Stop available, not a "loading" placeholder).
        expect(await screen.findByText("First answer continues")).toBeVisible();
        expect(screen.getAllByText("First question")).toHaveLength(1);
        const send = screen.getByRole("button", { name: "Send question" });
        expect(send).toBeDisabled();
        expect(send).toHaveAttribute("data-chat-loading", "false");
        expect(send).toHaveAttribute("data-can-send", "true");
        // ...and the rest of the answer streams into the returned thread.
        await body.send(
            'data: {"type":"content_delta","text":" and the rest"}\n\n',
        );
        expect(
            await screen.findByText("First answer continues and the rest"),
        ).toBeVisible();
        await body.close();
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Send question" }),
            ).toBeEnabled(),
        );
        expect(
            screen.getByText("First answer continues and the rest"),
        ).toBeVisible();
        expect(screen.getAllByText("First question")).toHaveLength(1);
        expect(requestSignal().aborted).toBe(false);
        expect(body.state.cancelled).toBe(false);
    });
    it("starting a new chat detaches the stream instead of aborting it", async () => {
        const body = controllableStream();
        state.streamProjectChat.mockResolvedValue(body.response);
        await renderWorkspace();
        fireEvent.click(screen.getByRole("button", { name: "Send question" }));
        await waitFor(() => expect(state.streamProjectChat).toHaveBeenCalled());
        await body.send('data: {"type":"chat_id","chatId":"created-chat"}\n\n');
        await body.send(
            'data: {"type":"content_delta","text":"First answer"}\n\n',
        );
        await waitFor(() =>
            expect(screen.getByText("First answer")).toBeVisible(),
        );

        fireEvent.click(screen.getByRole("button", { name: "New chat" }));
        await waitFor(() =>
            expect(window.location.pathname).toBe(
                "/projects/p1/assistant/chat",
            ),
        );

        expect(requestSignal().aborted).toBe(false);
        expect(body.state.cancelled).toBe(false);
        await body.send(
            'data: {"type":"content_delta","text":" and the rest"}\n\n',
        );
        await body.close();
        expect(body.state.cancelled).toBe(false);
        expect(screen.queryByText(/First answer/)).not.toBeInTheDocument();
        expect(screen.queryByText(/and the rest/)).not.toBeInTheDocument();
    });
});

describe("moving project documents", () => {
    it("puts a document back in its folder and says the move failed", async () => {
        // The move had no try/catch at all: the document stayed in its new
        // folder on screen while the server never accepted it, and the
        // rejection became an unhandled promise.
        clearToasts();
        vi.mocked(moveDocumentToFolder).mockRejectedValue(new Error("boom"));
        await renderWorkspace();
        expect(screen.getByTestId("draft-folder")).toHaveTextContent("root");

        fireEvent.click(screen.getByRole("button", { name: "Move draft" }));

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't move this document");
        // Reverted before the toast: only the moved document is restored.
        expect(screen.getByTestId("draft-folder")).toHaveTextContent("root");

        vi.mocked(moveDocumentToFolder).mockClear();
        vi.mocked(moveDocumentToFolder).mockResolvedValue(
            undefined as unknown as Awaited<
                ReturnType<typeof moveDocumentToFolder>
            >,
        );
        fireEvent.click(
            within(alert).getByRole("button", { name: "Retry" }),
        );
        await waitFor(() =>
            expect(moveDocumentToFolder).toHaveBeenCalledWith(
                "p1",
                "doc1",
                "folder-1",
            ),
        );
        clearToasts();
    });
});
