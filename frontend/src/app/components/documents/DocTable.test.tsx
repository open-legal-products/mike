import { useState, type ComponentProps } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Document } from "@/app/components/shared/types";
import {
    DocTable,
    type DocTableFolder,
    type DocTableSelectionActions,
} from "./DocTable";

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "user-1" } }),
}));

const ORIGINAL_DATE = "2026-01-01T00:00:00.000Z";
const SERVER_DATE = "2026-02-01T00:00:00.000Z";
const allowAll = () => true;

function document(id: string, filename: string): Document {
    return {
        id,
        user_id: "user-1",
        project_id: "project-1",
        folder_id: "folder-1",
        filename,
        file_type: "pdf",
        storage_path: `${id}.pdf`,
        pdf_storage_path: null,
        size_bytes: 10,
        page_count: 1,
        structure_tree: null,
        status: "ready",
        created_at: ORIGINAL_DATE,
        updated_at: ORIGINAL_DATE,
    };
}

type DocTableOperations = ComponentProps<typeof DocTable>["operations"];

function operations(
    moveDocument: DocTableOperations["moveDocument"],
): DocTableOperations {
    return {
        uploadDocument: vi.fn(),
        refreshCollection: vi.fn().mockResolvedValue(undefined),
        createFolder: vi.fn(),
        resolveFolderPath: vi.fn(),
        renameFolder: vi.fn(),
        deleteFolder: vi.fn(),
        moveFolder: vi.fn(),
        moveDocument,
        renameDocument: vi.fn(),
    };
}

function Harness({
    initialDocuments,
    tableOperations,
}: {
    initialDocuments: Document[];
    tableOperations: DocTableOperations;
}) {
    const [documents, setDocuments] = useState(initialDocuments);
    const [folders, setFolders] = useState<DocTableFolder[]>([
        {
            id: "folder-1",
            project_id: "project-1",
            user_id: "user-1",
            name: "Folder",
            parent_folder_id: null,
            created_at: ORIGINAL_DATE,
            updated_at: ORIGINAL_DATE,
        },
    ]);
    const [selectionActions, setSelectionActions] =
        useState<DocTableSelectionActions | null>(null);

    return (
        <>
            <output data-testid="documents-state">
                {JSON.stringify(documents)}
            </output>
            <button
                type="button"
                disabled={!selectionActions}
                onClick={() => void selectionActions?.onRemoveFromFolder()}
            >
                Remove selected
            </button>
            <DocTable
                scopeKey="project-1"
                documents={documents}
                setDocuments={setDocuments}
                folders={folders}
                setFolders={setFolders}
                loading={false}
                search=""
                operations={tableOperations}
                emptyStateTitle="Documents"
                canDo={allowAll}
                folderViewId="folder-1"
                onSelectionActionsChange={setSelectionActions}
            />
        </>
    );
}

describe("DocTable remove-from-folder failures", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("warns when removing one document fails", async () => {
        const user = userEvent.setup();
        const moveDocument = vi.fn().mockRejectedValue(new Error("failed"));
        const tableOperations = operations(moveDocument);
        render(
            <Harness
                initialDocuments={[document("doc-1", "One.pdf")]}
                tableOperations={tableOperations}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Open row actions" }));
        await user.click(
            screen.getByRole("button", { name: "Remove from subfolder" }),
        );

        expect(
            await screen.findByText(
                "The document could not be removed from its folder. Please try again.",
            ),
        ).toBeInTheDocument();
        expect(tableOperations.refreshCollection).toHaveBeenCalledOnce();
    });

    it("warns on partial bulk failure and merges successful server rows", async () => {
        const user = userEvent.setup();
        const moveDocument = vi.fn(async (id: string) => {
            if (id === "doc-2") throw new Error("failed");
            return {
                ...document(id, "One.pdf"),
                folder_id: null,
                updated_at: SERVER_DATE,
            };
        });
        const tableOperations = operations(moveDocument);
        render(
            <Harness
                initialDocuments={[
                    document("doc-1", "One.pdf"),
                    document("doc-2", "Two.pdf"),
                ]}
                tableOperations={tableOperations}
            />,
        );

        await user.click(screen.getByLabelText("Select One.pdf"));
        await user.click(screen.getByLabelText("Select Two.pdf"));
        await user.click(screen.getByRole("button", { name: "Remove selected" }));

        expect(
            await screen.findByText(
                "A document could not be removed from its folder. Please try again.",
            ),
        ).toBeInTheDocument();
        await waitFor(() =>
            expect(screen.getByTestId("documents-state")).toHaveTextContent(
                SERVER_DATE,
            ),
        );
        expect(tableOperations.refreshCollection).toHaveBeenCalledOnce();
    });
});
