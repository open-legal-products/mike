import { act, createRef } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Document } from "../shared/types";
import { withIntl } from "@/test/withIntl";
import { WorkflowAssets, type WorkflowAssetsHandle } from "./WorkflowAssets";

const { copyDocumentsToWorkflowAssets, listWorkflowAssets } = vi.hoisted(() => ({
    copyDocumentsToWorkflowAssets: vi.fn(),
    listWorkflowAssets: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/lib/mikeApi")>();
    return {
        ...actual,
        copyDocumentsToWorkflowAssets,
        listWorkflowAssets,
    };
});

vi.mock("../shared/DocumentSidePanel", () => ({
    DocumentSidePanel: ({ doc }: { doc: Document | null }) =>
        doc ? (
            <div data-testid="document-side-panel">{doc.filename}</div>
        ) : null,
}));

describe("WorkflowAssets", () => {
    beforeEach(() => {
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
            withIntl(
                <WorkflowAssets workflowId="workflow-1" readOnly={false} />,
            ),
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
            withIntl(
                <WorkflowAssets
                    ref={ref}
                    workflowId="workflow-1"
                    readOnly={false}
                />,
            ),
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
});
