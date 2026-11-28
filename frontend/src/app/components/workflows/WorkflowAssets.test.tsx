import { act, createRef } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastViewportUI, clearToasts } from "@mike/ui";
import type { Document } from "../shared/types";
import { WorkflowAssets, type WorkflowAssetsHandle } from "./WorkflowAssets";

const {
    copyDocumentsToWorkflowAssets,
    deleteWorkflowAsset,
    listWorkflowAssets,
    uploadWorkflowAssets,
} = vi.hoisted(() => ({
    copyDocumentsToWorkflowAssets: vi.fn(),
    deleteWorkflowAsset: vi.fn(),
    listWorkflowAssets: vi.fn(),
    uploadWorkflowAssets: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/lib/mikeApi")>();
    return {
        ...actual,
        copyDocumentsToWorkflowAssets,
        deleteWorkflowAsset,
        listWorkflowAssets,
        uploadWorkflowAssets,
    };
});

vi.mock("../shared/DocumentSidePanel", () => ({
    DocumentSidePanel: ({ doc }: { doc: Document | null }) =>
        doc ? (
            <div data-testid="document-side-panel">{doc.filename}</div>
        ) : null,
}));

describe("WorkflowAssets", () => {
    afterEach(() => clearToasts());

    beforeEach(() => {
        clearToasts();
        vi.clearAllMocks();
        listWorkflowAssets.mockResolvedValue([
            {
                id: "reference-1",
                workflow_id: "workflow-1",
                filename: "Precedent.docx",
                file_type: "docx",
                size_bytes: 42,
                created_at: "2026-08-28T00:00:00.000Z",
                updated_at: "2026-08-28T00:00:00.000Z",
            },
        ]);
        copyDocumentsToWorkflowAssets.mockResolvedValue([
            {
                id: "asset-2",
                workflow_id: "workflow-1",
                filename: "Saved file.pdf",
                file_type: "pdf",
                size_bytes: 84,
                created_at: "2026-08-28T00:00:00.000Z",
                updated_at: "2026-08-28T00:00:00.000Z",
            },
        ]);
    });

    it("opens an asset in the document side panel when its row is clicked", async () => {
        const user = userEvent.setup();
        render(
            <WorkflowAssets workflowId="workflow-1" readOnly={false} />,
        );

        await waitFor(() =>
            expect(screen.getByText("Precedent.docx")).toBeVisible(),
        );
        await user.click(screen.getByText("Precedent.docx"));

        expect(screen.getByTestId("document-side-panel")).toHaveTextContent(
            "Precedent.docx",
        );
    });

    it("selects assets with checkboxes and deletes the selection from the toolbar", async () => {
        const user = userEvent.setup();
        listWorkflowAssets.mockResolvedValue([
            {
                id: "asset-a",
                workflow_id: "workflow-1",
                filename: "Alpha.docx",
                file_type: "docx",
                size_bytes: 42,
                created_at: "2026-08-28T00:00:00.000Z",
                updated_at: "2026-08-28T00:00:00.000Z",
            },
            {
                id: "asset-b",
                workflow_id: "workflow-1",
                filename: "Beta.pdf",
                file_type: "pdf",
                size_bytes: 84,
                created_at: "2026-08-28T00:00:00.000Z",
                updated_at: "2026-08-28T00:00:00.000Z",
            },
        ]);
        deleteWorkflowAsset.mockResolvedValue(undefined);
        render(
            <WorkflowAssets
                workflowId="workflow-1"
                readOnly={false}
                renderToolbar={(actions) => (
                    <div data-testid="toolbar">{actions}</div>
                )}
            />,
        );
        await screen.findByText("Alpha.docx");

        // No "Actions" until something is selected.
        expect(
            screen.queryByRole("button", { name: /Actions/ }),
        ).not.toBeInTheDocument();
        await user.click(
            screen.getByRole("checkbox", { name: "Select Alpha.docx" }),
        );
        // Ticking a row selects it without opening it.
        expect(screen.queryByTestId("document-side-panel")).toBeNull();
        expect(
            screen.getByRole("checkbox", { name: "Select all assets" }),
        ).toBePartiallyChecked();

        await user.click(
            screen.getByRole("checkbox", { name: "Select all assets" }),
        );
        expect(
            screen.getByRole("checkbox", { name: "Select Beta.pdf" }),
        ).toBeChecked();

        await user.click(screen.getByRole("button", { name: /Actions/ }));
        await user.click(
            await screen.findByRole("menuitem", { name: /Delete 2 assets/ }),
        );
        expect(await screen.findByText("Delete 2 assets?")).toBeVisible();
        await user.click(screen.getByRole("button", { name: "Delete" }));

        await waitFor(() =>
            expect(screen.queryByText("Alpha.docx")).not.toBeInTheDocument(),
        );
        expect(deleteWorkflowAsset).toHaveBeenCalledWith("workflow-1", "asset-a");
        expect(deleteWorkflowAsset).toHaveBeenCalledWith("workflow-1", "asset-b");
        expect(screen.queryByText("Beta.pdf")).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: /Actions/ }),
        ).not.toBeInTheDocument();
    });

    it("copies selected saved documents into the workflow assets", async () => {
        const ref = createRef<WorkflowAssetsHandle>();
        render(
            <WorkflowAssets
                ref={ref}
                workflowId="workflow-1"
                readOnly={false}
            />,
        );
        await screen.findByText("Precedent.docx");

        act(() => {
            ref.current?.addSavedDocuments([
                { id: "saved-document-1" } as Document,
            ]);
        });

        await waitFor(() =>
            expect(copyDocumentsToWorkflowAssets).toHaveBeenCalledWith(
                "workflow-1",
                ["saved-document-1"],
            ),
        );
        expect(await screen.findByText("Saved file.pdf")).toBeVisible();
    });

    it("names the files an upload batch dropped and retries only those", async () => {
        const user = userEvent.setup();
        uploadWorkflowAssets.mockResolvedValue([
            {
                clientId: "c1",
                filename: "Good.pdf",
                status: "completed",
                result: {
                    id: "asset-3",
                    filename: "Good.pdf",
                    file_type: "pdf",
                    size_bytes: 1,
                    created_at: "2026-08-28T00:00:00.000Z",
                    updated_at: "2026-08-28T00:00:00.000Z",
                },
                errorCode: null,
            },
            {
                clientId: "c2",
                filename: "Bad.pdf",
                status: "error",
                result: null,
                errorCode: null,
            },
        ]);
        const ref = createRef<WorkflowAssetsHandle>();
        render(
            <>
                <WorkflowAssets
                    ref={ref}
                    workflowId="workflow-1"
                    readOnly={false}
                />
                <ToastViewportUI />
            </>,
        );
        await screen.findByText("Precedent.docx");

        act(() => {
            ref.current?.uploadFiles([
                new File(["a"], "Good.pdf", { type: "application/pdf" }),
                new File(["b"], "Bad.pdf", { type: "application/pdf" }),
            ]);
        });

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't upload 1 of 2 files");
        expect(alert).toHaveTextContent(
            "Bad.pdf could not be uploaded. Please try again.",
        );

        uploadWorkflowAssets.mockClear();
        uploadWorkflowAssets.mockResolvedValue([]);
        await user.click(screen.getByRole("button", { name: "Retry" }));

        await waitFor(() =>
            expect(uploadWorkflowAssets).toHaveBeenCalledWith("workflow-1", [
                { file: expect.objectContaining({ name: "Bad.pdf" }) },
            ]),
        );
    });

    it("reports a whole upload batch that never reached the server", async () => {
        uploadWorkflowAssets.mockRejectedValue(new TypeError("Failed to fetch"));
        const ref = createRef<WorkflowAssetsHandle>();
        render(
            <>
                <WorkflowAssets
                    ref={ref}
                    workflowId="workflow-1"
                    readOnly={false}
                />
                <ToastViewportUI />
            </>,
        );
        await screen.findByText("Precedent.docx");

        act(() => {
            ref.current?.uploadFiles([
                new File(["a"], "Dropped.pdf", { type: "application/pdf" }),
            ]);
        });

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't upload this file");
        expect(alert).not.toHaveTextContent("Failed to fetch");
    });
    it("reports a file refused as not a PDF, without a Retry that would resend it", async () => {
        const refused = new File(["plain text"], "Notes.pdf", { type: "application/pdf" });
        uploadWorkflowAssets.mockResolvedValueOnce([
          {clientId: "1", filename: refused.name, status: "error", result: null, errorCode: "invalid_pdf_file"},
        ]);
        const ref = createRef<WorkflowAssetsHandle>();
        render(<><WorkflowAssets ref={ref} workflowId="workflow-1" readOnly={false}/><ToastViewportUI/></>);
        await screen.findByText("Precedent.docx");
        act(() => { ref.current?.uploadFiles([refused]); });
        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Notes.pdf is not a valid PDF file.");
        expect(screen.queryByRole("button", {name: "Retry"})).toBeNull();
        expect(uploadWorkflowAssets).toHaveBeenCalledTimes(1);
    });
    it("retry does not resend the successful same-name file", async () => {
        const user = userEvent.setup();
        const good = new File(["good"], "Contract.pdf", { type: "application/pdf" });
        const bad = new File(["bad"], "Contract.pdf", { type: "application/pdf" });
        uploadWorkflowAssets.mockResolvedValueOnce([
          {clientId: "1", filename: good.name, status: "completed", result: {id: "landed", filename: good.name}, errorCode: null},
          {clientId: "2", filename: bad.name, status: "error", result: null, errorCode: null},
        ]).mockResolvedValue([]);
        const ref = createRef<WorkflowAssetsHandle>();
        render(<><WorkflowAssets ref={ref} workflowId="workflow-1" readOnly={false}/><ToastViewportUI/></>);
        await screen.findByText("Precedent.docx");
        act(() => { ref.current?.uploadFiles([good,bad]); });
        await screen.findByRole("alert");
        await user.click(screen.getByRole("button", {name: "Retry"}));
        await waitFor(() => expect(uploadWorkflowAssets).toHaveBeenCalledTimes(2));
        expect(uploadWorkflowAssets.mock.calls[1][1]).toHaveLength(1);
        expect(uploadWorkflowAssets.mock.calls[1][1][0].file).toBe(bad);
    });

});
