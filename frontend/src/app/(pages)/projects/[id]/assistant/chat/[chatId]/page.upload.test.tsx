import { Suspense } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UPLOAD_LIMIT_MESSAGES } from "@/shared/api/uploadSessionClient";
import { UNSUPPORTED_DOCUMENT_WARNING_MESSAGE } from "@/app/lib/documentUploadValidation";
import type { Document } from "@/app/components/shared/types";
import ProjectAssistantChatPage from "./page";

// What this file pins: the project-chat explorer's upload path. It used to
// throw away every per-file result — `uploaded` was filtered out of the
// outcomes and the failures were only `console.error`ed — so a bulk upload in
// which some files were refused looked to the user as though nothing at all
// had been selected (Open-Legal-Products/mike#8). It also had no file-type
// filter, so a drop of whatever happened to be under the cursor spent an
// upload session on files the converter cannot read.

const { getChat, getProject, uploadProjectDocuments } = vi.hoisted(() => ({
    getChat: vi.fn(),
    getProject: vi.fn(),
    uploadProjectDocuments: vi.fn(),
}));

// importOriginal so UploadBatchError and failedUploadMessage stay the real
// shared implementations: the copy under test is the one users would read.
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    getChat: (...args: unknown[]) => getChat(...args),
    getProject: (...args: unknown[]) => getProject(...args),
    uploadProjectDocuments: (...args: unknown[]) =>
        uploadProjectDocuments(...args),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/app/contexts/SidebarContext", () => ({
    useSidebar: () => ({ setSidebarOpen: vi.fn() }),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "u1", email: "owner@firm.test" } }),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: { displayName: "Owner" } }),
}));

vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        setCurrentChatId: vi.fn(),
        newChatMessages: null,
        setNewChatMessages: vi.fn(),
        chats: [],
        saveChat: vi.fn(),
        renameChat: vi.fn(),
    }),
}));

vi.mock("@/app/hooks/useAssistantChat", () => ({
    useAssistantChat: () => ({
        messages: [],
        isResponseLoading: false,
        handleChat: vi.fn(),
        setMessages: vi.fn(),
        cancel: vi.fn(),
    }),
}));

// The composer and the document viewers are exercised by their own suites and
// pull in heavy renderers; here they only have to not be the thing on trial.
vi.mock("@/app/components/assistant/ChatInput", () => ({
    ChatInput: () => <div>Composer</div>,
}));
vi.mock("@/app/components/shared/views/PdfView", () => ({
    PdfView: () => <div>PDF</div>,
}));
vi.mock("@/app/components/shared/views/DocxView", () => ({
    DocxView: () => <div>DOCX</div>,
}));
vi.mock("@/app/components/shared/views/SpreadsheetView", () => ({
    SpreadsheetView: () => <div>Spreadsheet</div>,
}));

// A thin explorer so the test can read back which documents the page actually
// attached after a partly-failed batch.
vi.mock("@/app/components/projects/ProjectExplorer", () => ({
    ProjectExplorer: ({ documents }: { documents: Document[] }) => (
        <ul data-testid="explorer">
            {documents.map((document) => (
                <li key={document.id}>{document.filename}</li>
            ))}
        </ul>
    ),
}));

const pdf = (name: string) =>
    new File(["body"], name, { type: "application/pdf" });

const document_ = (id: string, filename: string) =>
    ({ id, filename, project_id: "p1", file_type: "pdf" }) as Document;

// The page reads its route params with React's `use()`, which suspends until
// the promise settles — so it needs a boundary and a first await.
async function renderChatPage() {
    await act(async () => {
        render(
            <Suspense fallback={null}>
                <ProjectAssistantChatPage
                    params={Promise.resolve({ id: "p1", chatId: "c1" })}
                />
            </Suspense>,
        );
    });
    // The upload button is only enabled once the project's role is known, so
    // every test waits for the loaded project before selecting files.
    await waitFor(() =>
        expect(
            screen.getByTitle("Upload documents"),
        ).not.toBeDisabled(),
    );
}

function selectFiles(files: File[]) {
    const input = window.document.querySelector<HTMLInputElement>(
        'input[type="file"]',
    );
    fireEvent.change(input!, { target: { files } });
}

describe("project chat explorer uploads", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // PageHeader measures the viewport on an animation frame; jsdom has no
        // matchMedia, and the throw lands outside the test as an unhandled
        // error rather than a failure.
        window.matchMedia = vi.fn().mockImplementation((query: string) => ({
            matches: true,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        }));
        getChat.mockResolvedValue({
            chat: { id: "c1", title: "Chat", user_id: "u1" },
            messages: [],
        });
        getProject.mockResolvedValue({
            id: "p1",
            name: "Acquisition",
            access_role: "owner",
            is_owner: true,
            documents: [],
            folders: [],
        });
    });

    it("refuses file types the converter cannot read before opening a session", async () => {
        await renderChatPage();

        selectFiles([new File(["body"], "notes.xyz")]);

        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                UNSUPPORTED_DOCUMENT_WARNING_MESSAGE,
            ),
        );
        expect(uploadProjectDocuments).not.toHaveBeenCalled();
    });

    it("keeps the files that uploaded and names the ones that did not", async () => {
        uploadProjectDocuments.mockResolvedValue([
            {
                clientId: "1",
                filename: "Signed.pdf",
                status: "completed",
                result: document_("d1", "Signed.pdf"),
                errorCode: null,
            },
            {
                clientId: "2",
                filename: "Too big.pdf",
                status: "error",
                result: null,
                errorCode: "upload_file_too_large",
            },
        ]);

        await renderChatPage();
        selectFiles([pdf("Signed.pdf"), pdf("Too big.pdf")]);

        // The successful half is attached rather than discarded with the batch.
        await waitFor(() =>
            expect(screen.getByTestId("explorer")).toHaveTextContent(
                "Signed.pdf",
            ),
        );
        expect(screen.getByRole("alert")).toHaveTextContent(
            UPLOAD_LIMIT_MESSAGES.upload_file_too_large!,
        );
    });

    it("reports the unsupported files and the refused ones together", async () => {
        uploadProjectDocuments.mockResolvedValue([
            {
                clientId: "1",
                filename: "Rejected.pdf",
                status: "error",
                result: null,
                errorCode: null,
            },
        ]);

        await renderChatPage();
        selectFiles([pdf("Rejected.pdf"), new File(["body"], "notes.xyz")]);

        await waitFor(() =>
            expect(uploadProjectDocuments).toHaveBeenCalledWith("p1", [
                { file: expect.objectContaining({ name: "Rejected.pdf" }) },
            ]),
        );
        await waitFor(() => {
            const alert = screen.getByRole("alert");
            expect(alert).toHaveTextContent(
                UNSUPPORTED_DOCUMENT_WARNING_MESSAGE,
            );
            expect(alert).toHaveTextContent(
                "Rejected.pdf could not be uploaded. Please try again.",
            );
        });
    });

    it("does not leak a transport error into the explorer", async () => {
        uploadProjectDocuments.mockRejectedValue(
            new TypeError("Failed to fetch"),
        );

        await renderChatPage();
        selectFiles([pdf("Signed.pdf")]);

        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                "Documents could not be uploaded. Please try again.",
            ),
        );
        expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
    });

    it("lets the warning be dismissed", async () => {
        await renderChatPage();
        selectFiles([new File(["body"], "notes.xyz")]);

        await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
        fireEvent.click(screen.getByRole("button", { name: "Dismiss warning" }));
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
});
