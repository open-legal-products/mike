import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
    uploadStandaloneDocuments: vi.fn(),
    uploadProjectDocuments: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    addDocumentToProject: vi.fn(),
    getProject: vi.fn(),
    uploadProjectDocuments: apiMocks.uploadProjectDocuments,
    uploadStandaloneDocuments: apiMocks.uploadStandaloneDocuments,
}));

vi.mock("./Modal", () => ({
    Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../shared/FileDirectory", () => ({
    FileDirectory: ({
        documents,
        uploadingFilenames,
    }: {
        documents: Array<{ filename: string }>;
        uploadingFilenames: string[];
    }) => (
        <div>
            <div data-testid="loaded-files">
                {documents.map((document) => document.filename).join(",")}
            </div>
            <div data-testid="loading-files">{uploadingFilenames.join(",")}</div>
        </div>
    ),
}));

import { AddDocumentsModal } from "./AddDocumentsModal";

function document(id: string, filename: string) {
    return { id, filename, project_id: null, folder_id: null };
}

describe("AddDocumentsModal upload progress", () => {
    beforeEach(() => vi.clearAllMocks());

    it("replaces each loading row as that file completes and names failures", async () => {
        let finishUpload!: () => void;
        const uploadCanFinish = new Promise<void>((resolve) => {
            finishUpload = resolve;
        });
        apiMocks.uploadStandaloneDocuments.mockImplementation(
            async (inputs, options) => {
                const first = document("doc-1", "first.pdf");
                options?.onProgress?.({
                    clientId: inputs[0].clientId,
                    filename: "first.pdf",
                    status: "completed",
                    result: first,
                    errorCode: null,
                });
                await uploadCanFinish;
                options?.onProgress?.({
                    clientId: inputs[1].clientId,
                    filename: "failed.pdf",
                    status: "error",
                    result: null,
                    errorCode: "processing_failed",
                });
                return [
                    {
                        clientId: inputs[0].clientId,
                        filename: "first.pdf",
                        status: "completed",
                        result: first,
                        errorCode: null,
                    },
                    {
                        clientId: inputs[1].clientId,
                        filename: "failed.pdf",
                        status: "error",
                        result: null,
                        errorCode: "processing_failed",
                    },
                ];
            },
        );

        const { container } = render(
            <AddDocumentsModal
                open
                onClose={vi.fn()}
                onSelect={vi.fn()}
                breadcrumb={["Documents"]}
            />,
        );
        const input = container.querySelector('input[type="file"]');
        expect(input).not.toBeNull();
        fireEvent.change(input!, {
            target: {
                files: [
                    new File(["one"], "first.pdf", {
                        type: "application/pdf",
                    }),
                    new File(["two"], "failed.pdf", {
                        type: "application/pdf",
                    }),
                ],
            },
        });

        await waitFor(() => {
            expect(screen.getByTestId("loaded-files")).toHaveTextContent(
                "first.pdf",
            );
            expect(screen.getByTestId("loading-files")).toHaveTextContent(
                "failed.pdf",
            );
            expect(screen.getByTestId("loading-files")).not.toHaveTextContent(
                "first.pdf",
            );
        });

        await act(async () => finishUpload());

        await waitFor(() => {
            expect(screen.getByTestId("loading-files")).toBeEmptyDOMElement();
            expect(
                screen.getByText(
                    "failed.pdf could not be uploaded. Please try again.",
                ),
            ).toBeInTheDocument();
        });
    });

    it("keeps an active loading row and its result across a remount", async () => {
        let finishUpload!: (uploaded: ReturnType<typeof document>) => void;
        let reportCompleted!: (uploaded: ReturnType<typeof document>) => void;
        apiMocks.uploadStandaloneDocuments.mockImplementation(
            (inputs, options) =>
                new Promise((resolve) => {
                    reportCompleted = (uploaded) => {
                        options?.onProgress?.({
                            clientId: inputs[0].clientId,
                            filename: uploaded.filename,
                            status: "completed",
                            result: uploaded,
                            errorCode: null,
                        });
                    };
                    finishUpload = (uploaded) =>
                        resolve([
                            {
                                clientId: inputs[0].clientId,
                                filename: uploaded.filename,
                                status: "completed",
                                result: uploaded,
                                errorCode: null,
                            },
                        ]);
                }),
        );

        const props = {
            open: true,
            onClose: vi.fn(),
            onSelect: vi.fn(),
            breadcrumb: ["Remount test", crypto.randomUUID()],
            uploadStateId: crypto.randomUUID(),
        };
        const firstRender = render(<AddDocumentsModal {...props} />);
        const input = firstRender.container.querySelector('input[type="file"]');
        fireEvent.change(input!, {
            target: {
                files: [
                    new File(["one"], "survives.pdf", {
                        type: "application/pdf",
                    }),
                ],
            },
        });
        await waitFor(() => {
            expect(screen.getByTestId("loading-files")).toHaveTextContent(
                "survives.pdf",
            );
        });

        firstRender.unmount();
        render(<AddDocumentsModal {...props} />);
        expect(screen.getByTestId("loading-files")).toHaveTextContent(
            "survives.pdf",
        );

        const uploaded = document("doc-remounted", "survives.pdf");
        await act(async () => {
            reportCompleted(uploaded);
            finishUpload(uploaded);
        });

        await waitFor(() => {
            expect(screen.getByTestId("loading-files")).toBeEmptyDOMElement();
            expect(screen.getByTestId("loaded-files")).toHaveTextContent(
                "survives.pdf",
            );
        });
    });

    it("keeps in-flight upload state when the breadcrumb text changes", async () => {
        apiMocks.uploadProjectDocuments.mockImplementation(
            () => new Promise(() => {}),
        );

        // A rename mid-upload rewrites the breadcrumb. The persistence key must
        // not move with it, or the running upload is stranded in an orphaned
        // store entry and its documents never reach the selection.
        const projectId = crypto.randomUUID();
        const firstRender = render(
            <AddDocumentsModal
                open
                onClose={vi.fn()}
                onSelect={vi.fn()}
                projectId={projectId}
                breadcrumb={["Projects", "Original name", "Add Documents"]}
            />,
        );
        fireEvent.change(
            firstRender.container.querySelector('input[type="file"]')!,
            {
                target: {
                    files: [
                        new File(["one"], "renamed.pdf", {
                            type: "application/pdf",
                        }),
                    ],
                },
            },
        );
        await waitFor(() => {
            expect(screen.getByTestId("loading-files")).toHaveTextContent(
                "renamed.pdf",
            );
        });

        firstRender.unmount();
        render(
            <AddDocumentsModal
                open
                onClose={vi.fn()}
                onSelect={vi.fn()}
                projectId={projectId}
                breadcrumb={["Projects", "Renamed project", "Add Documents"]}
            />,
        );

        expect(screen.getByTestId("loading-files")).toHaveTextContent(
            "renamed.pdf",
        );
    });
});
