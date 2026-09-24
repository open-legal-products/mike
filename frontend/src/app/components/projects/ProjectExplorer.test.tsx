import { createRef } from "react";
import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
    Document,
    Folder as ProjectFolder,
} from "@/app/components/shared/types";
import { ProjectExplorer, type ProjectExplorerHandle } from "./ProjectExplorer";

afterEach(() => {
    if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
    vi.useRealTimers();
});

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
        expect(uploadRow.lastElementChild).toHaveClass("animate-spin");
        expect(uploadRow.querySelector("img")).toHaveClass("grayscale", "opacity-35");
        expect(uploadRow).not.toHaveTextContent("Uploading…");
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
    it("downloads a document from its context menu without opening it", () => {
        const document = { id: "doc-1", filename: "Draft.docx", file_type: "docx", folder_id: null } as Document;
        const onDownloadDoc = vi.fn().mockResolvedValue(undefined);
        const onDocClick = vi.fn();
        render(<ProjectExplorer documents={[document]} onDocClick={onDocClick} onDownloadDoc={onDownloadDoc} />);
        fireEvent.contextMenu(screen.getByText("Draft.docx"));
        fireEvent.click(screen.getByRole("button", { name: "Download" }));
        expect(onDownloadDoc).toHaveBeenCalledWith(document);
        expect(onDocClick).not.toHaveBeenCalled();
        expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    });

    it("offers a folder download and disables it while another download starts", () => {
        const folder = { id: "folder-1", name: "Drafts", parent_folder_id: null } as ProjectFolder;
        const onDownloadFolder = vi.fn().mockResolvedValue(undefined);
        const { rerender } = render(<ProjectExplorer documents={[]} folders={[folder]} onDocClick={vi.fn()} onDownloadFolder={onDownloadFolder} downloading />);
        fireEvent.contextMenu(screen.getByText("Drafts"));
        expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();
        rerender(<ProjectExplorer documents={[]} folders={[folder]} onDocClick={vi.fn()} onDownloadFolder={onDownloadFolder} />);
        fireEvent.click(screen.getByRole("button", { name: "Download" }));
        expect(onDownloadFolder).toHaveBeenCalledWith(folder);
    });

    it("allows documents to be copied to chat or moved within the explorer", () => {
        vi.useFakeTimers();
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
            setDragImage: vi.fn(),
        };
        fireEvent.dragStart(screen.getByText("Draft.docx").closest("li")!, {
            dataTransfer,
        });

        expect(dataTransfer.setData).toHaveBeenCalledWith(
            "application/mike-doc",
            "doc-1",
        );
        expect(dataTransfer.effectAllowed).toBe("copyMove");
        expect(dataTransfer.setDragImage).toHaveBeenCalledOnce();
        const [preview] = dataTransfer.setDragImage.mock.calls[0] as [HTMLElement];
        expect(preview).toHaveClass("liquid-glass-float");
        expect(preview.style.clipPath).toBe("inset(0 round var(--radius))");
        expect((preview.firstElementChild as HTMLElement).style.backgroundColor).toBe("transparent");
        expect(preview).toHaveTextContent("Draft.docx");
    });

    it("uses a rounded folder drag preview without including expanded children", () => {
        vi.useFakeTimers();
        render(<ProjectExplorer documents={[{ id: "doc", filename: "Child.pdf", folder_id: "folder" } as Document]}
            folders={[{ id: "folder", name: "Drafts", parent_folder_id: null } as ProjectFolder]} onDocClick={vi.fn()} />);
        fireEvent.click(screen.getByText("Drafts"));
        const dataTransfer = { effectAllowed: "none", setData: vi.fn(), setDragImage: vi.fn() };
        fireEvent.dragStart(screen.getByText("Drafts").closest("div[draggable]")!, { dataTransfer });
        const [preview] = dataTransfer.setDragImage.mock.calls[0] as [HTMLElement];
        expect(preview).toHaveClass("liquid-glass-float");
        expect(preview.style.borderRadius).toBe("var(--radius)");
        expect(preview).toHaveTextContent("Drafts");
        expect(preview).not.toHaveTextContent("Child.pdf");
        expect(dataTransfer.effectAllowed).toBe("move");
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

describe("ProjectExplorer moves", () => {
    afterEach(() => {
        clearToasts();
    });

    it("says a dropped document did not move and offers a Retry", async () => {
        // The drop is fired as `void handleDropOnTarget(...)`: an unhandled
        // rejection used to be the only trace of a move that never happened.
        const onMoveDoc = vi.fn().mockRejectedValue(new Error("boom"));
        render(
            <>
                <ProjectExplorer
                    documents={[
                        {
                            id: "doc-1",
                            filename: "Draft.docx",
                            folder_id: null,
                        } as Document,
                    ]}
                    folders={[
                        {
                            id: "folder-1",
                            name: "Drafts",
                            parent_folder_id: null,
                        } as ProjectFolder,
                    ]}
                    onDocClick={vi.fn()}
                    onMoveDoc={onMoveDoc}
                />
                <ToastViewportUI />
            </>,
        );

        const dataTransfer = {
            types: ["application/mike-doc"],
            getData: (type: string) =>
                type === "application/mike-doc" ? "doc-1" : "",
        };
        fireEvent.drop(screen.getByText("Drafts").closest("div[draggable]")!, {
            dataTransfer,
        });

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't move this document");
        expect(onMoveDoc).toHaveBeenCalledWith("doc-1", "folder-1");

        onMoveDoc.mockClear();
        onMoveDoc.mockResolvedValue(undefined);
        fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
        await waitFor(() =>
            expect(onMoveDoc).toHaveBeenCalledWith("doc-1", "folder-1"),
        );
    });
});
