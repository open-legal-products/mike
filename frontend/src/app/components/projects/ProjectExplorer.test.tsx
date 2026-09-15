import { createRef } from "react";
import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
    Document,
    Folder as ProjectFolder,
} from "@/app/components/shared/types";
import { ProjectExplorer, type ProjectExplorerHandle } from "./ProjectExplorer";

describe("ProjectExplorer uploads", () => {
    it("shows pending uploads as rows inside the rounded explorer outline", () => {
        render(
            <ProjectExplorer
                projectName="Matter files"
                documents={[]}
                onDocClick={vi.fn()}
                uploadingDocuments={[
                    { clientId: "upload-1", filename: "evidence.pdf" },
                ]}
            />,
        );

        const uploadRow = screen.getByRole("status", {
            name: "Uploading evidence.pdf",
        });
        expect(uploadRow).toBeVisible();
        expect(uploadRow).toHaveStyle({ paddingLeft: "8px" });
        expect(screen.getByText("Matter files")).toHaveClass("font-semibold");
        expect(screen.queryByText("No documents in this project.")).toBeNull();
        expect(screen.getByRole("list")).toHaveClass(
            "rounded-bl-2xl",
            "rounded-br-lg",
        );
    });
});

describe("ProjectExplorer actions", () => {
    it("allows documents to be copied to chat or moved within the explorer", () => {
        render(
            <ProjectExplorer
                documents={[
                    {
                        id: "doc-1",
                        filename: "Draft.docx",
                        file_type: "docx",
                        folder_id: null,
                    } as Document,
                ]}
                onDocClick={vi.fn()}
            />,
        );

        const dataTransfer = {
            effectAllowed: "none",
            setData: vi.fn(),
        };
        fireEvent.dragStart(screen.getByText("Draft.docx").closest("li")!, {
            dataTransfer,
        });

        expect(dataTransfer.setData).toHaveBeenCalledWith(
            "application/mike-doc",
            "doc-1",
        );
        expect(dataTransfer.effectAllowed).toBe("copyMove");
    });

    it("starts a root subfolder from the explorer header action", () => {
        const ref = createRef<ProjectExplorerHandle>();
        render(
            <ProjectExplorer
                ref={ref}
                documents={[]}
                onDocClick={vi.fn()}
                onCreateFolder={vi.fn()}
            />,
        );

        act(() => ref.current?.createRootFolder());

        expect(screen.getByPlaceholderText("Folder name")).toBeVisible();
    });

    it("shows rename and creates a subfolder inside the selected folder", async () => {
        const onCreateFolder = vi.fn().mockResolvedValue(undefined);
        render(
            <ProjectExplorer
                documents={[]}
                folders={[
                    {
                        id: "folder-1",
                        name: "Drafts",
                        parent_folder_id: null,
                    } as ProjectFolder,
                ]}
                onDocClick={vi.fn()}
                onCreateFolder={onCreateFolder}
                onRenameFolder={vi.fn()}
            />,
        );

        fireEvent.contextMenu(screen.getByText("Drafts"));

        expect(screen.getByRole("button", { name: "Rename" })).toBeVisible();
        fireEvent.click(screen.getByRole("button", { name: "New subfolder" }));
        const input = screen.getByPlaceholderText("Folder name");
        fireEvent.change(input, { target: { value: "Revisions" } });
        fireEvent.keyDown(input, { key: "Enter" });
        await waitFor(() =>
            expect(onCreateFolder).toHaveBeenCalledWith(
                "folder-1",
                "Revisions",
            ),
        );
    });

    it("opens a file in the document view or adds it to chat from its context menu", () => {
        const document = {
            id: "doc-1",
            filename: "Draft.docx",
            file_type: "docx",
            folder_id: null,
        } as Document;
        const onDocClick = vi.fn();
        const onAddToChat = vi.fn();
        render(
            <ProjectExplorer
                documents={[document]}
                onDocClick={onDocClick}
                onAddToChat={onAddToChat}
            />,
        );

        fireEvent.contextMenu(screen.getByText("Draft.docx"));
        fireEvent.click(screen.getByRole("button", { name: "Open" }));
        expect(onDocClick).toHaveBeenCalledWith(document);
        expect(screen.queryByRole("button", { name: "Open" })).toBeNull();

        fireEvent.contextMenu(screen.getByText("Draft.docx"));
        fireEvent.click(screen.getByRole("button", { name: "Add to chat" }));
        expect(onAddToChat).toHaveBeenCalledWith(document);
    });

    it("disables add to chat for a read-only composer", () => {
        render(
            <ProjectExplorer
                documents={[
                    {
                        id: "doc-1",
                        filename: "Draft.docx",
                        file_type: "docx",
                        folder_id: null,
                    } as Document,
                ]}
                onDocClick={vi.fn()}
                onAddToChat={vi.fn()}
                addToChatDisabled
            />,
        );
        fireEvent.contextMenu(screen.getByText("Draft.docx"));
        expect(
            screen.getByRole("button", { name: "Add to chat" }),
        ).toBeDisabled();
    });

    it("renames a file without offering new subfolder", async () => {
        const onRenameDoc = vi.fn().mockResolvedValue(undefined);
        render(
            <ProjectExplorer
                documents={[
                    {
                        id: "doc-1",
                        filename: "Draft.docx",
                        file_type: "docx",
                        folder_id: null,
                    } as Document,
                ]}
                onDocClick={vi.fn()}
                onCreateFolder={vi.fn()}
                onRenameDoc={onRenameDoc}
            />,
        );

        fireEvent.contextMenu(screen.getByText("Draft.docx"));
        expect(
            screen.queryByRole("button", { name: "New subfolder" }),
        ).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Rename" }));

        const input = screen.getByDisplayValue("Draft.docx");
        fireEvent.change(input, { target: { value: "Final.docx" } });
        fireEvent.keyDown(input, { key: "Enter" });

        await waitFor(() =>
            expect(onRenameDoc).toHaveBeenCalledWith("doc-1", "Final.docx"),
        );
    });
});
