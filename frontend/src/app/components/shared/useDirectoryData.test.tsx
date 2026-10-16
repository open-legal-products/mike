import type { ReactNode } from "react";
import { act, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentWorkspaceScope } from "@/app/contexts/WorkspaceContext";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";
import { useDirectoryData } from "./useDirectoryData";

const { getLibrary, getLibraryFolderChildren, listProjectSummaries } =
    vi.hoisted(() => ({
        getLibrary: vi.fn(),
        getLibraryFolderChildren: vi.fn(),
        listProjectSummaries: vi.fn(),
    }));

vi.mock("@/app/lib/mikeApi", () => ({
    getLibrary,
    getLibraryFolderChildren,
    getProjectDirectoryLevel: vi.fn(),
    listProjectSummaries,
    // WorkspaceContext reads these; no provider is mounted here.
    listOrgs: vi.fn(async () => []),
    getOrgApiKeys: vi.fn(),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "u1" } }),
}));

const FIRM = "org-firm";
function inWorkspace(orgId: string | null) {
    return function Workspace({ children }: { children: ReactNode }) {
        return (
            <DocumentWorkspaceScope orgId={orgId}>
                {children}
            </DocumentWorkspaceScope>
        );
    };
}

// More rows than a page, so there is a next page to ask for.
const manyProjects = Array.from({ length: 60 }, (_, index) => ({
    id: `project-${index}`,
    name: `Matter ${index}`,
}));

describe("useDirectoryData", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getLibrary.mockResolvedValue({
            documents: [],
            folders: [],
            documentsHasMore: false,
        });
        listProjectSummaries.mockResolvedValue([]);
    });

    it("lists the projects of the workspace the picker was opened in", async () => {
        // A chat or review takes documents from its own workspace only, so
        // the Projects tab offers that workspace's projects and no others.
        renderHook(() => useDirectoryData(true, "projects"), {
            wrapper: inWorkspace(FIRM),
        });

        await waitFor(() => expect(listProjectSummaries).toHaveBeenCalled());
        expect(listProjectSummaries).toHaveBeenCalledWith(
            expect.objectContaining({ workspace: FIRM }),
        );
    });

    it("lists personal projects for a personal item", async () => {
        renderHook(() => useDirectoryData(true, "projects"), {
            wrapper: inWorkspace(null),
        });

        await waitFor(() => expect(listProjectSummaries).toHaveBeenCalled());
        expect(listProjectSummaries).toHaveBeenCalledWith(
            expect.objectContaining({ workspace: "personal" }),
        );
    });

    it("asks for the next page of projects in the same workspace", async () => {
        listProjectSummaries.mockResolvedValue(manyProjects);
        const { result } = renderHook(
            () => useDirectoryData(true, "projects"),
            { wrapper: inWorkspace(FIRM) },
        );
        await waitFor(() => expect(result.current.projectsHasMore).toBe(true));

        await act(async () => {
            await result.current.loadMoreProjects();
        });

        expect(listProjectSummaries).toHaveBeenCalledTimes(2);
        expect(listProjectSummaries.mock.calls[1][0]).toMatchObject({
            workspace: FIRM,
        });
        expect(listProjectSummaries.mock.calls[1][0].offset).toBeGreaterThan(0);
    });

    it("reads the library of that workspace too", async () => {
        renderHook(() => useDirectoryData(true, "files"), {
            wrapper: inWorkspace(FIRM),
        });

        await waitFor(() => expect(getLibrary).toHaveBeenCalled());
        expect(getLibrary.mock.calls[0][0]).toEqual({
            kind: "files",
            workspace: FIRM,
        });
    });
});

const EMPTY_LEVEL = { documents: [], folders: [], documentsHasMore: false };

function WithToasts({ children }: { children: ReactNode }) {
    return (
        <DocumentWorkspaceScope orgId={null}>
            {children}
            <ToastViewportUI />
        </DocumentWorkspaceScope>
    );
}

function renderDirectory(tab: "files" | "projects" = "files") {
    return renderHook(() => useDirectoryData(true, tab), {
        wrapper: WithToasts,
    });
}

describe("useDirectoryData failures", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearToasts();
        getLibrary.mockResolvedValue(EMPTY_LEVEL);
        getLibraryFolderChildren.mockResolvedValue(EMPTY_LEVEL);
        listProjectSummaries.mockResolvedValue([]);
    });

    afterEach(() => {
        clearToasts();
    });

    // The catch emptied the tab and logged to the console: the directory
    // looked like an empty shelf instead of a failed request.
    it("tells the user when the files tab cannot be loaded", async () => {
        getLibrary.mockRejectedValue(new Error("boom"));

        renderDirectory();

        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                "Couldn't load your files",
            ),
        );
        expect(screen.getByRole("alert")).not.toHaveTextContent("boom");
    });

    it("retries the tab load from the notice", async () => {
        const user = userEvent.setup();
        getLibrary.mockRejectedValueOnce(new TypeError("Failed to fetch"));

        renderDirectory();

        await waitFor(() => screen.getByRole("alert"));
        await user.click(screen.getByRole("button", { name: "Retry" }));

        await waitFor(() => expect(getLibrary).toHaveBeenCalledTimes(2));
    });

    it("tells the user when a folder's contents cannot be loaded", async () => {
        getLibraryFolderChildren.mockRejectedValue(new Error("boom"));

        const { result } = renderDirectory();
        await waitFor(() => expect(getLibrary).toHaveBeenCalled());

        await act(async () => {
            await result.current.loadFolderChildren("files", "folder-1");
        });

        expect(screen.getByRole("alert")).toHaveTextContent(
            "Couldn't open the folder",
        );
    });

    it("tells the user when the next page of projects fails", async () => {
        listProjectSummaries.mockResolvedValueOnce(manyProjects);

        const { result } = renderDirectory("projects");
        await waitFor(() => expect(result.current.projectsHasMore).toBe(true));

        listProjectSummaries.mockRejectedValueOnce(new Error("boom"));
        await act(async () => {
            await result.current.loadMoreProjects();
        });

        expect(screen.getByRole("alert")).toHaveTextContent(
            "Couldn't load more projects",
        );
    });
});
