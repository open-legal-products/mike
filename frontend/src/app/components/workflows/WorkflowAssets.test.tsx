import { act, createRef } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";
import type { Document } from "../shared/types";
import { WorkflowAssets, type WorkflowAssetsHandle } from "./WorkflowAssets";

const {
    copyDocumentsToWorkflowAssets,
    listWorkflowAssets,
    uploadWorkflowAssets,
} = vi.hoisted(() => ({
    copyDocumentsToWorkflowAssets: vi.fn(),
    listWorkflowAssets: vi.fn(),
    uploadWorkflowAssets: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/lib/mikeApi")>();
    return {
        ...actual,
        copyDocumentsToWorkflowAssets,
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
});
