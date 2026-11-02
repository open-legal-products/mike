/**
 * The paginated lists follow the active workspace: each sends it with every
 * request, and a switch is a new query — the pages already on screen belong
 * to the other workspace and must not stay there.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    listProjectIds,
    listProjectsPage,
    listSystemWorkflows,
    listTabularReviewIds,
    listTabularReviews,
    listWorkflowIds,
    listWorkflowsPage,
} from "@/app/lib/mikeApi";
import { usePaginatedProjects } from "./usePaginatedProjects";
import { usePaginatedTabularReviews } from "./usePaginatedTabularReviews";
import { usePaginatedWorkflows } from "./usePaginatedWorkflows";

const workspace = vi.hoisted(() => ({ current: "personal" as string | undefined }));

vi.mock("@/app/contexts/WorkspaceContext", () => ({
    useWorkspaceParam: () => workspace.current,
}));
vi.mock("@/app/lib/mikeApi", () => ({
    listProjectsPage: vi.fn(),
    listProjectIds: vi.fn(),
    listSystemWorkflows: vi.fn(),
    listWorkflowsPage: vi.fn(),
    listWorkflowIds: vi.fn(),
    listTabularReviews: vi.fn(),
    listTabularReviewIds: vi.fn(),
}));

const ORG = "7b1d9d0e-3c5a-4f6e-9a51-0c2f7d3e8a11";
const row = (id: string) => ({ id, user_id: "user-1" });
// One more than a page, so hasMore is true and select-all goes to the network.
const fullPage = (prefix: string) =>
    Array.from({ length: 31 }, (_, index) => row(`${prefix}-${index}`));

beforeEach(() => {
    vi.clearAllMocks();
    workspace.current = "personal";
    vi.mocked(listSystemWorkflows).mockResolvedValue([]);
    vi.mocked(listProjectIds).mockResolvedValue([]);
    vi.mocked(listWorkflowIds).mockResolvedValue([]);
    vi.mocked(listTabularReviewIds).mockResolvedValue([]);
});

describe("usePaginatedProjects", () => {
    it("sends the workspace with the page and the select-all ids, and reloads on a switch", async () => {
        const list = vi.mocked(listProjectsPage);
        list.mockImplementation(async (options) =>
            fullPage(options?.workspace ?? "all") as never,
        );
        const { result, rerender } = renderHook(() =>
            usePaginatedProjects({ search: "" }),
        );
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(list).toHaveBeenLastCalledWith(
            expect.objectContaining({ workspace: "personal" }),
        );
        expect(result.current.projects[0].id).toBe("personal-0");

        await act(() => result.current.selectAllMatching());
        expect(listProjectIds).toHaveBeenLastCalledWith(
            expect.objectContaining({ workspace: "personal" }),
        );

        workspace.current = ORG;
        rerender();
        // The other workspace's rows leave the screen before the new ones
        // arrive, not after.
        expect(result.current.projects).toEqual([]);
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(list).toHaveBeenLastCalledWith(
            expect.objectContaining({ workspace: ORG }),
        );
        expect(result.current.projects[0].id).toBe(`${ORG}-0`);
        // A selection made in one workspace does not carry into the next.
        expect(result.current.selectedProjectIds).toEqual([]);
    });
});

describe("usePaginatedWorkflows", () => {
    it("sends the workspace and reloads on a switch", async () => {
        const list = vi.mocked(listWorkflowsPage);
        list.mockResolvedValue([]);
        const { result, rerender } = renderHook(() =>
            usePaginatedWorkflows({ search: "" }),
        );
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(list).toHaveBeenLastCalledWith(
            expect.objectContaining({ workspace: "personal" }),
        );
        const callsBefore = list.mock.calls.length;

        workspace.current = ORG;
        rerender();
        await waitFor(() =>
            expect(list.mock.calls.length).toBeGreaterThan(callsBefore),
        );
        expect(list).toHaveBeenLastCalledWith(
            expect.objectContaining({ workspace: ORG }),
        );
    });
});

describe("usePaginatedTabularReviews", () => {
    it("keeps an overview's project filter workspace-scoped for pages and select-all", async () => {
        const list = vi.mocked(listTabularReviews);
        list.mockResolvedValue(fullPage("personal") as never);
        const { result, rerender } = renderHook(() => usePaginatedTabularReviews({
            projectId: "personal-project", scopeToWorkspace: true,
        }));
        await waitFor(() => expect(result.current.loading).toBe(false));
        await act(() => result.current.loadMore());
        expect(list).toHaveBeenLastCalledWith("personal-project",
            expect.objectContaining({ workspace: "personal", offset: 30 }));
        await act(() => result.current.selectAllMatching());
        expect(listTabularReviewIds).toHaveBeenLastCalledWith("personal-project",
            expect.objectContaining({ workspace: "personal" }));

        let resolve!: (rows: never[]) => void;
        list.mockReturnValueOnce(new Promise(done => { resolve = done; }));
        workspace.current = ORG;
        rerender();
        expect(result.current.reviews).toEqual([]);
        expect(result.current.selectedReviewIds).toEqual([]);
        expect(list).toHaveBeenLastCalledWith("personal-project",
            expect.objectContaining({ workspace: ORG }));
        await act(async () => resolve([]));
        expect(result.current.reviews).toEqual([]);
    });

    it("sends the workspace for the cross-project list and reloads on a switch", async () => {
        const list = vi.mocked(listTabularReviews);
        list.mockResolvedValue([]);
        const { result, rerender } = renderHook(() =>
            usePaginatedTabularReviews({ search: "" }),
        );
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(list).toHaveBeenLastCalledWith(
            undefined,
            expect.objectContaining({ workspace: "personal" }),
        );

        workspace.current = ORG;
        rerender();
        await waitFor(() =>
            expect(list).toHaveBeenLastCalledWith(
                undefined,
                expect.objectContaining({ workspace: ORG }),
            ),
        );
    });

    it("does not narrow a single project's reviews by workspace", async () => {
        // A project opened by link may sit in a different workspace from the
        // active one; its own list is already scoped by the project.
        const list = vi.mocked(listTabularReviews);
        list.mockResolvedValue([]);
        workspace.current = ORG;
        const { result, rerender } = renderHook(() =>
            usePaginatedTabularReviews({ projectId: "project-1", search: "" }),
        );
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(list).toHaveBeenLastCalledWith(
            "project-1",
            expect.objectContaining({ workspace: undefined }),
        );
        const calls = list.mock.calls.length;

        workspace.current = "personal";
        rerender();
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(list.mock.calls.length).toBe(calls);
    });
});
