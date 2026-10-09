import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DocTable, type DocTableFolder } from "./DocTable";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";
import type { Document } from "@/app/components/shared/types";
import { MikeApiError } from "@/app/lib/mikeApi";

const api = vi.hoisted(() => ({
    uploadDocumentVersion: vi.fn(),
    listDocumentVersions: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    uploadDocumentVersion: api.uploadDocumentVersion,
    listDocumentVersions: api.listDocumentVersions,
}));

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

function makeOperations() {
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
    } as Parameters<typeof DocTable>[0]["operations"];
}

function Harness({ documents: initial }: { documents: Document[] }) {
    const [documents, setDocuments] = useState(initial);
    const [folders, setFolders] = useState<DocTableFolder[]>([]);
    return (
        <>
            <DocTable
                scopeKey="test"
                documents={documents}
                setDocuments={setDocuments}
                folders={folders}
                setFolders={setFolders}
                loading={false}
                search=""
                operations={makeOperations()}
                emptyStateTitle="No documents"
                canDo={() => true}
            />
            <ToastViewportUI />
        </>
    );
}

function dropFilesOnRow(docId: string, files: File[]) {
    const row = document.querySelector(
        `[data-document-row][data-document-id="${docId}"]`,
    );
    expect(row).not.toBeNull();
    fireEvent.drop(row!, {
        dataTransfer: { types: ["Files"], files, items: [] },
    });
}

const serverDown = () =>
    new MikeApiError({ message: "API error: 503", status: 503 });

/**
 * Each version upload is a new row on the server, so a Retry that re-sends
 * a file which already landed stores it twice. These pin that the Retry on
 * a version failure re-sends only what did not land.
 */
describe("DocTable version upload Retry", () => {
    beforeEach(() => {
        clearToasts();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        api.uploadDocumentVersion.mockReset();
        api.listDocumentVersions.mockReset();
    });
    afterEach(() => {
        clearToasts();
        vi.restoreAllMocks();
    });

    it("re-reads, and does not re-upload, when only the refresh after an upload fails", async () => {
        const user = userEvent.setup();
        api.uploadDocumentVersion.mockResolvedValue({ id: "v2" });
        api.listDocumentVersions
            .mockRejectedValueOnce(serverDown())
            .mockResolvedValue({ versions: [], current_version_id: null });

        render(<Harness documents={[makeDoc("doc-1", "Lease.pdf")]} />);
        dropFilesOnRow("doc-1", [
            new File(["v2"], "Lease v2.pdf", { type: "application/pdf" }),
        ]);

        await user.click(await screen.findByRole("button", { name: "Retry" }));

        await waitFor(() =>
            expect(api.listDocumentVersions).toHaveBeenCalledTimes(2),
        );
        expect(api.uploadDocumentVersion).toHaveBeenCalledTimes(1);
    });

    it("re-sends only the files that did not land when a multi-file drop fails part-way", async () => {
        const user = userEvent.setup();
        api.uploadDocumentVersion
            .mockResolvedValueOnce({ id: "v2" })
            .mockRejectedValueOnce(serverDown())
            .mockResolvedValue({ id: "v3" });
        api.listDocumentVersions.mockResolvedValue({
            versions: [],
            current_version_id: null,
        });

        render(<Harness documents={[makeDoc("doc-1", "Lease.pdf")]} />);
        const first = new File(["a"], "A.pdf", { type: "application/pdf" });
        const second = new File(["b"], "B.pdf", { type: "application/pdf" });
        dropFilesOnRow("doc-1", [first, second]);

        await user.click(await screen.findByRole("button", { name: "Retry" }));

        await waitFor(() =>
            expect(api.uploadDocumentVersion).toHaveBeenCalledTimes(3),
        );
        const sent = api.uploadDocumentVersion.mock.calls.map(
            (call) => (call[1] as File).name,
        );
        // A.pdf once (it landed), B.pdf twice (failed, then retried).
        expect(sent).toEqual(["A.pdf", "B.pdf", "B.pdf"]);
    });
});
