import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { can, type Capability } from "@/app/lib/permissions";
import { DocTable } from "./DocTable";

// What this file pins: before uploading, files whose exact bytes already
// exist in the collection (or twice in one upload) are shown, and the user
// decides: skip them, upload anyway, or cancel.

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "me", email: "me@firm.test" } }),
}));
// Content-addressed stand-in for SHA-256: the "hash" is the file's text.
vi.mock("@/app/lib/fileHash", () => ({
    sha256Hex: async (file: File) => `hash:${await file.text()}`,
}));

const operations = {
    uploadDocuments: vi.fn(),
    findDuplicates: vi.fn(),
    refreshCollection: vi.fn(async () => {}),
    createFolder: vi.fn(),
    resolveFolderPath: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolder: vi.fn(async () => {}),
    moveFolder: vi.fn(),
    moveDocument: vi.fn(),
    renameDocument: vi.fn(),
};

function renderTable() {
    const view = render(
        <DocTable
            scopeKey="project:p1"
            documents={[]}
            setDocuments={vi.fn()}
            folders={[]}
            setFolders={vi.fn()}
            loading={false}
            search=""
            operations={operations as never}
            emptyStateTitle="Documents"
            canDo={(capability: Capability) => can("editor", capability)}
        />,
    );
    const input = view.container.querySelector(
        'input[type="file"][multiple]:not([webkitdirectory])',
    ) as HTMLInputElement;
    return { input };
}

function choose(input: HTMLInputElement, files: File[]) {
    fireEvent.change(input, { target: { files } });
}

const lease = () => new File(["lease"], "Lease.pdf", { type: "application/pdf" });
const leaseCopy = () =>
    new File(["lease"], "Lease (1).pdf", { type: "application/pdf" });
const other = () => new File(["other"], "Other.pdf", { type: "application/pdf" });

function uploadedNames(): string[] {
    const files = operations.uploadDocuments.mock.calls[0][0] as { file: File }[];
    return files.map((entry) => entry.file.name);
}

beforeEach(() => {
    vi.clearAllMocks();
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
    }));
    operations.uploadDocuments.mockImplementation(
        async (files: { file: File; clientId: string }[]) =>
            files.map(({ file, clientId }) => ({
                clientId,
                filename: file.name,
                status: "completed",
                result: { id: `doc-${file.name}`, filename: file.name },
            })),
    );
    operations.findDuplicates.mockResolvedValue({
        "hash:lease": [{ id: "d1", filename: "Lease.pdf", folder_id: null }],
    });
});

describe("DocTable duplicate check before upload", () => {
    it("skips duplicates when asked to", async () => {
        const { input } = renderTable();
        choose(input, [lease(), other()]);

        expect(await screen.findByText("This file is already here")).toBeInTheDocument();
        expect(
            screen.getByText("Lease.pdf: already here as Lease.pdf"),
        ).toBeInTheDocument();
        expect(operations.findDuplicates).toHaveBeenCalledWith([
            "hash:lease",
            "hash:other",
        ]);
        expect(operations.uploadDocuments).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Skip duplicates" }));
        await waitFor(() => expect(operations.uploadDocuments).toHaveBeenCalled());
        expect(uploadedNames()).toEqual(["Other.pdf"]);
    });

    it("uploads everything on 'Upload anyway'", async () => {
        const { input } = renderTable();
        choose(input, [lease(), other()]);
        fireEvent.click(await screen.findByRole("button", { name: "Upload anyway" }));
        await waitFor(() => expect(operations.uploadDocuments).toHaveBeenCalled());
        expect(uploadedNames()).toEqual(["Lease.pdf", "Other.pdf"]);
    });

    it("uploads nothing on Cancel", async () => {
        const { input } = renderTable();
        choose(input, [lease(), other()]);
        fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
        await waitFor(() =>
            expect(screen.queryByText("This file is already here")).not.toBeInTheDocument(),
        );
        expect(operations.uploadDocuments).not.toHaveBeenCalled();
    });

    it("catches the same file twice in one upload", async () => {
        operations.findDuplicates.mockResolvedValue({});
        const { input } = renderTable();
        choose(input, [lease(), leaseCopy(), other()]);

        expect(
            await screen.findByText(
                "Lease (1).pdf: same file as Lease.pdf in this upload",
            ),
        ).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Skip duplicates" }));
        await waitFor(() => expect(operations.uploadDocuments).toHaveBeenCalled());
        expect(uploadedNames()).toEqual(["Lease.pdf", "Other.pdf"]);
    });

    it("uploads without asking when nothing is a duplicate", async () => {
        operations.findDuplicates.mockResolvedValue({});
        const { input } = renderTable();
        choose(input, [other()]);
        await waitFor(() => expect(operations.uploadDocuments).toHaveBeenCalled());
        expect(screen.queryByText(/already here/)).not.toBeInTheDocument();
    });

    it("uploads unchecked when the check fails", async () => {
        operations.findDuplicates.mockRejectedValue(new Error("offline"));
        const { input } = renderTable();
        choose(input, [lease()]);
        await waitFor(() => expect(operations.uploadDocuments).toHaveBeenCalled());
        expect(uploadedNames()).toEqual(["Lease.pdf"]);
    });
});
