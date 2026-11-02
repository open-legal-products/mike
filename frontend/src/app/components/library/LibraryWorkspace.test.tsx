import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    getLibraryFilterOptions,
    getLibraryLevels,
} from "@/app/lib/mikeApi";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";
import {
    LibraryCollectionPage,
    LibraryWorkspaceLayout,
} from "./LibraryWorkspace";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/app/lib/mikeApi", () => ({
    bulkDeleteLibraryDocuments: vi.fn(),
    createLibraryFolder: vi.fn(),
    deleteLibraryFolder: vi.fn(),
    getLibrary: vi.fn(),
    getLibraryFilterOptions: vi.fn(),
    getLibraryFolderChildren: vi.fn(),
    getLibraryFolderPath: vi.fn(),
    getLibraryLevels: vi.fn(),
    listLibraryDocumentIds: vi.fn(),
    moveLibraryDocument: vi.fn(),
    moveLibraryFolder: vi.fn(),
    renameLibraryDocument: vi.fn(),
    renameLibraryFolder: vi.fn(),
    resolveLibraryFolderPath: vi.fn(),
    searchLibraryDocuments: vi.fn(),
    uploadLibraryDocument: vi.fn(),
    uploadLibraryDocuments: vi.fn(),
}));

// The table itself is not under test here; only what the workspace does when
// one of its loads fails.
vi.mock("@/app/components/documents/DocTable", () => ({
    DocTable: () => null,
}));

function renderLibrary() {
    return render(
        <>
            <LibraryWorkspaceLayout>
                <LibraryCollectionPage kind="files" />
            </LibraryWorkspaceLayout>
            <ToastViewportUI />
        </>,
    );
}

describe("LibraryCollectionPage failures", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearToasts();
        window.matchMedia = vi.fn().mockImplementation((query: string) => ({
            matches: true,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        }));
        vi.mocked(getLibraryFilterOptions).mockResolvedValue({
            fileTypes: [],
        } as never);
        vi.mocked(getLibraryLevels).mockResolvedValue({
            levels: [
                {
                    parentId: null,
                    documents: [],
                    folders: [],
                    documentsHasMore: false,
                },
            ],
        } as never);
    });

    afterEach(() => {
        clearToasts();
    });

    // The catch resets the kind to an empty collection, which is exactly what
    // an empty library looks like. Before this it only reached the console.
    it("tells the user when the library cannot be loaded", async () => {
        vi.mocked(getLibraryLevels).mockRejectedValue(new Error("boom"));

        renderLibrary();

        await waitFor(() =>
            expect(
                screen.getByText("Couldn't load your files"),
            ).toBeInTheDocument(),
        );
    });

    it("retries the library load from the toast", async () => {
        const user = userEvent.setup();
        vi.mocked(getLibraryLevels).mockRejectedValueOnce(new Error("boom"));

        renderLibrary();

        await waitFor(() => screen.getByText("Couldn't load your files"));
        await user.click(screen.getByRole("button", { name: "Retry" }));

        await waitFor(() =>
            expect(getLibraryLevels).toHaveBeenCalledTimes(2),
        );
    });

    it("tells the user when the file type filter cannot be loaded", async () => {
        vi.mocked(getLibraryFilterOptions).mockRejectedValue(
            new Error("boom"),
        );

        renderLibrary();

        await waitFor(() =>
            expect(
                screen.getByText("Couldn't load the file type filter"),
            ).toBeInTheDocument(),
        );
    });
});
