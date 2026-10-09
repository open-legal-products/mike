import type { ReactNode } from "react";
import { act, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    getLibrary,
    getLibraryFolderChildren,
    listProjectSummaries,
} from "@/app/lib/mikeApi";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";
import { useDirectoryData } from "./useDirectoryData";

vi.mock("@/app/lib/mikeApi", () => ({
    getLibrary: vi.fn(),
    getLibraryFolderChildren: vi.fn(),
    getProjectDirectoryLevel: vi.fn(),
    listProjectSummaries: vi.fn(),
}));

const EMPTY_LEVEL = {
    documents: [],
    folders: [],
    documentsHasMore: false,
};

function Wrapper({ children }: { children: ReactNode }) {
    return (
        <>
            {children}
            <ToastViewportUI />
        </>
    );
}

function renderDirectory(tab: "files" | "projects" = "files") {
    return renderHook(() => useDirectoryData(true, tab), { wrapper: Wrapper });
}

describe("useDirectoryData failures", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearToasts();
        vi.mocked(getLibrary).mockResolvedValue(EMPTY_LEVEL as never);
        vi.mocked(getLibraryFolderChildren).mockResolvedValue(
            EMPTY_LEVEL as never,
        );
        vi.mocked(listProjectSummaries).mockResolvedValue([]);
    });

    afterEach(() => {
        clearToasts();
    });

    // Before this, the catch emptied the tab and logged to the console: the
    // directory looked like an empty shelf instead of a failed request.
    it("tells the user when the files tab cannot be loaded", async () => {
        vi.mocked(getLibrary).mockRejectedValue(new Error("boom"));

        renderDirectory();

        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                "Couldn't load your files",
            ),
        );
        expect(screen.getByRole("alert")).toHaveTextContent(
            /Something went wrong/i,
        );
    });

    it("retries the tab load from the toast", async () => {
        const user = userEvent.setup();
        vi.mocked(getLibrary).mockRejectedValueOnce(new Error("boom"));

        renderDirectory();

        await waitFor(() => screen.getByRole("alert"));
        await user.click(screen.getByRole("button", { name: "Retry" }));

        await waitFor(() => expect(getLibrary).toHaveBeenCalledTimes(2));
    });

    it("tells the user when a folder's contents cannot be loaded", async () => {
        vi.mocked(getLibraryFolderChildren).mockRejectedValue(
            new Error("boom"),
        );

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
        vi.mocked(listProjectSummaries).mockResolvedValueOnce(
            Array.from({ length: 41 }, (_, index) => ({
                id: `p${index}`,
            })) as never,
        );

        const { result } = renderDirectory("projects");
        await waitFor(() => expect(result.current.projectsHasMore).toBe(true));

        vi.mocked(listProjectSummaries).mockRejectedValueOnce(
            new Error("boom"),
        );
        await act(async () => {
            await result.current.loadMoreProjects();
        });

        expect(screen.getByRole("alert")).toHaveTextContent(
            "Couldn't load more projects",
        );
    });
});
