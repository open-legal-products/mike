import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    DocTable,
    type DocTableFolder,
    type DocTableSelectionActions,
} from "./DocTable";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";
import type { Document } from "@/app/components/shared/types";

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "user-1", email: "me@example.com" } }),
}));

function makeDoc(id: string, filename: string): Document {
    return {
        id,
        filename,
        file_type: "pdf",
        size_bytes: 10,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        user_id: "user-1",
        folder_id: null,
        status: "ready",
    } as unknown as Document;
}

function makeOperations(
    overrides: Partial<Parameters<typeof DocTable>[0]["operations"]> = {},
) {
    return {
        uploadDocument: vi.fn(),
        refreshCollection: vi.fn().mockResolvedValue(undefined),
        createFolder: vi.fn(),
        resolveFolderPath: vi.fn(),
        renameFolder: vi.fn(),
        deleteFolder: vi.fn(),
        moveFolder: vi.fn(),
        moveDocument: vi.fn(),
        renameDocument: vi.fn(),
        ...overrides,
    } as Parameters<typeof DocTable>[0]["operations"];
}

function Harness({
    documents: initialDocuments,
    operations,
    onActions,
    onExpandFolder,
    folderViewId,
}: {
    documents: Document[];
    operations: Parameters<typeof DocTable>[0]["operations"];
    onActions?: (actions: DocTableSelectionActions | null) => void;
    onExpandFolder?: (folderId: string) => Promise<void>;
    folderViewId?: string | null;
}) {
    const [documents, setDocuments] = useState(initialDocuments);
    const [folders, setFolders] = useState<DocTableFolder[]>([
        {
            id: "folder-1",
            name: "Contracts",
            parent_folder_id: null,
        } as DocTableFolder,
    ]);
    return (
        <>
            <output data-testid="documents-state">
                {JSON.stringify(documents)}
            </output>
            <DocTable
                scopeKey="test"
                documents={documents}
                setDocuments={setDocuments}
                folders={folders}
                setFolders={setFolders}
                loading={false}
                search=""
                operations={operations}
                emptyStateTitle="No documents"
                canDo={() => true}
                onSelectionActionsChange={onActions}
                onExpandFolder={onExpandFolder}
                folderViewId={folderViewId}
            />
            <ToastViewportUI />
        </>
    );
}

describe("DocTable failure reporting", () => {
    beforeEach(() => {
        clearToasts();
    });
    afterEach(() => {
        clearToasts();
        vi.clearAllMocks();
    });

    it("restores the rows and names the files when a bulk delete fails", async () => {
        const user = userEvent.setup();
        let actions: DocTableSelectionActions | null = null;
        const bulkDeleteDocuments = vi
            .fn()
            .mockRejectedValue(new Error("boom"));

        render(
            <Harness
                documents={[
                    makeDoc("doc-1", "Lease.pdf"),
                    makeDoc("doc-2", "NDA.pdf"),
                ]}
                operations={makeOperations({ bulkDeleteDocuments })}
                onActions={(next) => {
                    actions = next;
                }}
            />,
        );

        await user.click(screen.getByLabelText("Select Lease.pdf"));
        await waitFor(() => expect(actions).not.toBeNull());
        await actions!.onDelete();

        // Confirm the destructive action the same way a user would.
        await user.click(
            await screen.findByRole("button", { name: /^delete$/i }),
        );

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't delete the document");
        expect(alert).toHaveTextContent("Lease.pdf");
        // The optimistically removed row is back in the table.
        expect(screen.getByText("Lease.pdf")).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Retry" }),
        ).toBeInTheDocument();
    });

    it("puts a document back in its folder when moving it to the root fails", async () => {
        const user = userEvent.setup();
        let actions: DocTableSelectionActions | null = null;
        const inFolder = {
            ...makeDoc("doc-1", "Lease.pdf"),
            folder_id: "folder-1",
        };
        const moveDocument = vi.fn().mockRejectedValue(new Error("boom"));

        render(
            <Harness
                documents={[inFolder]}
                folderViewId="folder-1"
                operations={makeOperations({ moveDocument })}
                onActions={(next) => {
                    actions = next;
                }}
            />,
        );

        await user.click(screen.getByLabelText("Select Lease.pdf"));
        await waitFor(() => expect(actions).not.toBeNull());
        await actions!.onRemoveFromFolder();

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't move the document");
        expect(alert).toHaveTextContent("Lease.pdf");
        expect(moveDocument).toHaveBeenCalledWith("doc-1", null);
    });

    it("retries only the documents whose move out of a folder failed", async () => {
        const user = userEvent.setup();
        let actions: DocTableSelectionActions | null = null;
        const moveDocument = vi
            .fn()
            .mockImplementation(async (id: string) => {
                if (id === "doc-1") throw new Error("boom");
            });

        render(
            <Harness
                documents={[
                    { ...makeDoc("doc-1", "Lease.pdf"), folder_id: "folder-1" },
                    { ...makeDoc("doc-2", "NDA.pdf"), folder_id: "folder-1" },
                ]}
                folderViewId="folder-1"
                operations={makeOperations({ moveDocument })}
                onActions={(next) => {
                    actions = next;
                }}
            />,
        );

        await user.click(screen.getByLabelText("Select Lease.pdf"));
        await user.click(screen.getByLabelText("Select NDA.pdf"));
        await waitFor(() => expect(actions).not.toBeNull());
        await actions!.onRemoveFromFolder();

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Lease.pdf",
        );
        moveDocument.mockClear();
        await user.click(screen.getByRole("button", { name: "Retry" }));

        // Only the row that failed is sent again: NDA.pdf already moved.
        await waitFor(() => expect(moveDocument).toHaveBeenCalledTimes(1));
        expect(moveDocument).toHaveBeenCalledWith("doc-1", null);
    });

    it("reports a failed download of the selection with a retry", async () => {
        const user = userEvent.setup();
        let actions: DocTableSelectionActions | null = null;

        render(
            <Harness
                documents={[makeDoc("doc-1", "Lease.pdf")]}
                operations={makeOperations()}
                onActions={(next) => {
                    actions = next;
                }}
            />,
        );

        await user.click(screen.getByLabelText("Select Lease.pdf"));
        await waitFor(() => expect(actions).not.toBeNull());
        await actions!.onDownload();

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't download the selected files");
        expect(
            screen.getByRole("button", { name: "Retry" }),
        ).toBeInTheDocument();
    });
});

// Ported from #498, which surfaced these same two failures through a blocking
// WarningPopup. The recovery it added — re-reading the collection and keeping
// the server's copy of the rows that did move — is kept; only the surface
// changed, so the assertions now read the toast.
describe("DocTable remove-from-folder recovery", () => {
    const SERVER_DATE = "2026-02-01T00:00:00.000Z";
    const inFolder = (id: string, filename: string): Document => ({
        ...makeDoc(id, filename),
        folder_id: "folder-1",
    });

    beforeEach(() => {
        clearToasts();
        vi.clearAllMocks();
    });
    afterEach(() => {
        clearToasts();
    });

    it("re-reads the collection and reports when removing one document fails", async () => {
        const user = userEvent.setup();
        const moveDocument = vi.fn().mockRejectedValue(new Error("failed"));
        const operations = makeOperations({ moveDocument });

        render(
            <Harness
                documents={[inFolder("doc-1", "One.pdf")]}
                folderViewId="folder-1"
                operations={operations}
            />,
        );

        await user.click(
            screen.getByRole("button", { name: "Open row actions" }),
        );
        await user.click(
            screen.getByRole("button", { name: "Remove from subfolder" }),
        );

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent(
            "Couldn't remove the document from its folder",
        );
        await waitFor(() =>
            expect(operations.refreshCollection).toHaveBeenCalledOnce(),
        );
    });

    it("reports a partial bulk failure and keeps the server rows that did move", async () => {
        const user = userEvent.setup();
        let actions: DocTableSelectionActions | null = null;
        const moveDocument = vi.fn(async (id: string) => {
            if (id === "doc-2") throw new Error("failed");
            return {
                ...inFolder(id, "One.pdf"),
                folder_id: null,
                updated_at: SERVER_DATE,
            };
        });
        const operations = makeOperations({ moveDocument });

        render(
            <Harness
                documents={[
                    inFolder("doc-1", "One.pdf"),
                    inFolder("doc-2", "Two.pdf"),
                ]}
                folderViewId="folder-1"
                operations={operations}
                onActions={(next) => {
                    actions = next;
                }}
            />,
        );

        await user.click(screen.getByLabelText("Select One.pdf"));
        await user.click(screen.getByLabelText("Select Two.pdf"));
        await waitFor(() => expect(actions).not.toBeNull());
        await actions!.onRemoveFromFolder();

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't move the document");
        // The named failure is the one that stayed behind, not the one that moved.
        expect(alert).toHaveTextContent("Two.pdf");
        await waitFor(() =>
            expect(screen.getByTestId("documents-state")).toHaveTextContent(
                SERVER_DATE,
            ),
        );
        await waitFor(() =>
            expect(operations.refreshCollection).toHaveBeenCalledOnce(),
        );
    });
});
