import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentWorkspaceScope } from "@/app/contexts/WorkspaceContext";
import { FileDirectory } from "./FileDirectory";

const { searchProjectDirectory, searchLibraryDocuments } = vi.hoisted(() => ({
    searchProjectDirectory: vi.fn(),
    searchLibraryDocuments: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    searchProjectDirectory,
    searchLibraryDocuments,
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "u1" } }),
}));
vi.mock("./useDirectoryData", () => ({
    useDirectoryData: () => ({
        loadingTabs: {},
        standaloneDocuments: [],
        templateDocuments: [],
        fileFolders: [],
        templateFolders: [],
        projects: [],
        loadedFolderIds: { files: new Set(), templates: new Set() },
        loadingFolderIds: { files: new Set(), templates: new Set() },
        documentsHasMoreByLevel: { files: {}, templates: {} },
        loadingMoreDocumentsByLevel: { files: {}, templates: {} },
        loadTab: vi.fn(),
    }),
}));

const FIRM = "org-firm";

function picker(initialTab: "files" | "projects") {
    return render(
        <DocumentWorkspaceScope orgId={FIRM}>
            <FileDirectory
                selectedDocuments={[]}
                onChange={vi.fn()}
                showTabs
                initialTab={initialTab}
            />
        </DocumentWorkspaceScope>,
    );
}

// Searching looks where the tabs list: the workspace of the item the picker
// was opened from. A match from another workspace could only be refused.
describe("FileDirectory search", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        searchProjectDirectory.mockResolvedValue([]);
        searchLibraryDocuments.mockResolvedValue({
            documents: [],
            documentsHasMore: false,
        });
    });

    it("searches projects in the picker's workspace", async () => {
        picker("projects");
        fireEvent.change(screen.getByPlaceholderText("Search..."), {
            target: { value: "lease" },
        });

        await waitFor(() => expect(searchProjectDirectory).toHaveBeenCalled());
        expect(searchProjectDirectory).toHaveBeenCalledWith(
            expect.objectContaining({ search: "lease", workspace: FIRM }),
        );
    });

    it("searches the library in the picker's workspace", async () => {
        picker("files");
        fireEvent.change(screen.getByPlaceholderText("Search..."), {
            target: { value: "lease" },
        });

        await waitFor(() => expect(searchLibraryDocuments).toHaveBeenCalled());
        expect(searchLibraryDocuments.mock.calls[0][0]).toEqual({
            kind: "files",
            workspace: FIRM,
        });
    });
});
