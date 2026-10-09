import { useState, type ComponentProps } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SelectionActionsMenu } from "@/app/components/shared/SelectionActionsMenu";
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
    folderViewId = "folder-1",
}: {
    initialDocuments: Document[];
    tableOperations: DocTableOperations;
    folderViewId?: string | null;
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
            {selectionActions && (
                <SelectionActionsMenu renderItems={selectionActions.renderMenuItems} />
            )}
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
                folderViewId={folderViewId}
                onSelectionActionsChange={setSelectionActions}
            />
        </>
    );
}

describe("DocTable remove-from-folder failures", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each([1, 2])("matches toolbar and right-click actions for %i selected documents", async (count) => {
        const user = userEvent.setup();
        render(<Harness
            initialDocuments={[document("doc-1", "One.pdf"), document("doc-2", "Two.pdf")]}
            tableOperations={operations(vi.fn())}
        />);
        await user.click(screen.getByLabelText("Select One.pdf"));
        if (count === 2) await user.click(screen.getByLabelText("Select Two.pdf"));
        await user.click(screen.getByRole("button", { name: "Actions" }));
        const toolbarItems = screen.getAllByRole("menuitem").map((item) => item.textContent);
        expect(toolbarItems).toContain("Deselect rows");
        if (count === 1) expect(toolbarItems).toContain("Rename document");
        else expect(toolbarItems).toContain("Delete 2 items");
        await user.keyboard("{Escape}");
        fireEvent.contextMenu(screen.getByText("One.pdf"), { clientX: 40, clientY: 40 });
        expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(toolbarItems);
        await user.click(screen.getByRole("menuitem", { name: "Deselect rows" }));
        expect(screen.queryByRole("button", { name: "Actions" })).not.toBeInTheDocument();
    });

    it.each([false, true])("matches folder right-click actions for a mixed selection: %s", async (mixed) => {
        const user = userEvent.setup();
        render(<Harness
            initialDocuments={[{ ...document("doc-1", "One.pdf"), folder_id: null }]}
            tableOperations={operations(vi.fn())}
            folderViewId={null}
        />);
        await user.click(screen.getByLabelText("Select files in Folder"));
        if (mixed) await user.click(screen.getByLabelText("Select One.pdf"));
        await user.click(screen.getByRole("button", { name: "Actions" }));
        const toolbarItems = screen.getAllByRole("menuitem").map((item) => item.textContent);
        if (!mixed) {
            expect(toolbarItems).toContain("Open");
            expect(toolbarItems).toContain("Rename folder");
            expect(toolbarItems).toContain("New subfolder inside");
        } else expect(toolbarItems).toContain("Delete 2 items");
        await user.keyboard("{Escape}");
        fireEvent.contextMenu(screen.getByText("Folder"), { clientX: 40, clientY: 40 });
        expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(toolbarItems);
    });

    it("keeps focus in the rename field after a toolbar action", async () => {
        const user = userEvent.setup();
        const tableOperations = operations(vi.fn());
        render(<Harness initialDocuments={[document("doc-1", "One.pdf")]} tableOperations={tableOperations} />);
        await user.click(screen.getByLabelText("Select One.pdf"));
        await user.click(screen.getByRole("button", { name: "Actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Rename document" }));
        const input = screen.getByDisplayValue("One.pdf");
        await waitFor(() => expect(input).toHaveFocus());
        expect(tableOperations.renameDocument).not.toHaveBeenCalled();
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
            screen.getByRole("menuitem", { name: "Remove from subfolder" }),
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
        await user.click(screen.getByRole("button", { name: "Actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Remove from subfolder" }));

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

describe("DocTable empty state", () => {
    it("offers the secondary action beside Upload without opening the upload picker", async () => {
        const onClick = vi.fn();
        const openUpload = vi.fn();
        render(
            <DocTable
                scopeKey="templates"
                documents={[]}
                setDocuments={vi.fn()}
                folders={[]}
                setFolders={vi.fn()}
                loading={false}
                search=""
                operations={operations(vi.fn())}
                emptyStateTitle="Templates"
                emptyStateSecondaryAction={{ label: "Presets", onClick }}
                renderAddDocumentsModal={(open) => {
                    if (open) openUpload();
                    return null;
                }}
                canDo={allowAll}
            />,
        );

        expect(screen.getByRole("button", { name: "Upload" })).toBeVisible();
        await userEvent.click(screen.getByRole("button", { name: "Presets" }));

        expect(onClick).toHaveBeenCalledTimes(1);
        expect(openUpload).not.toHaveBeenCalled();
    });
});
