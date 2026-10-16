import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, TabularReview } from "@/app/components/shared/types";
import { listTabularReviews } from "@/app/lib/mikeApi";
import { notifyTabularReviewsChanged } from "@/app/lib/tabularReviewChanges";
import { useSidebarHistory } from "./useSidebarHistory";

const state = vi.hoisted(() => ({
    workspace: "personal",
    chats: [] as Chat[],
    hasMoreChats: false,
    loadMoreChats: vi.fn(),
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({ useWorkspaceParam: () => state.workspace }));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({ ...state, loadingMoreChats: false }),
}));
vi.mock("@/app/lib/mikeApi", () => ({ listTabularReviews: vi.fn(), listTabularReviewIds: vi.fn() }));
const review = (id: string, project_id: string | null = null) => ({
    id, title: id, project_id, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-15T00:00:00Z",
}) as TabularReview;

beforeEach(() => {
    vi.clearAllMocks();
    state.workspace = "personal";
    state.chats = [];
    state.hasMoreChats = false;
    vi.mocked(listTabularReviews).mockResolvedValue([]);
});

describe("useSidebarHistory", () => {
    it("promotes an edited or rerun review above newer chats without a loading reset", async () => {
        state.chats = [{ ...review("chat"), updated_at: "2026-10-16T01:00:00Z" } as Chat];
        vi.mocked(listTabularReviews).mockResolvedValueOnce([review("older-review")]);
        const { result } = renderHook(() => useSidebarHistory());
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.items.map(({ item }) => item.id)).toEqual(["chat", "older-review"]);
        vi.mocked(listTabularReviews).mockResolvedValueOnce([
            { ...review("older-review"), updated_at: "2026-10-16T02:00:00Z", is_running: true },
        ]);
        act(() => notifyTabularReviewsChanged());
        expect(result.current.loading).toBe(false);
        await waitFor(() => expect(result.current.items.map(({ item }) => item.id)).toEqual(["older-review", "chat"]));
    });

    it("loads both review scopes in the active workspace sorted by update time", async () => {
        vi.mocked(listTabularReviews).mockResolvedValue([review("project", "p1"), review("standalone")]);
        const { result } = renderHook(() => useSidebarHistory());
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(listTabularReviews).toHaveBeenCalledWith(undefined, expect.objectContaining({
            workspace: "personal", scope: "all", sortKey: "updated", sortDirection: "desc",
        }));
        expect(result.current.items.map(({ item }) => item.id)).toEqual(["project", "standalone"]);
    });

    it("loads another review page and asks the chat source for more", async () => {
        vi.mocked(listTabularReviews).mockResolvedValueOnce(Array.from({ length: 31 }, (_, i) => review(`r${i}`)));
        const { result } = renderHook(() => useSidebarHistory());
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.hasMore).toBe(true);
        vi.mocked(listTabularReviews).mockResolvedValueOnce([review("last")]);
        await act(() => result.current.loadMore());
        expect(listTabularReviews).toHaveBeenLastCalledWith(undefined, expect.objectContaining({
            offset: 30, workspace: "personal", sortKey: "updated",
        }));
        expect(state.loadMoreChats).toHaveBeenCalledOnce();
        expect(result.current.items).toHaveLength(31);
        expect(result.current.hasMore).toBe(false);
    });

    it("refreshes after review changes and ignores the previous workspace's response", async () => {
        let resolve!: (reviews: TabularReview[]) => void;
        vi.mocked(listTabularReviews).mockReturnValueOnce(new Promise(done => { resolve = done; }));
        const { result, rerender } = renderHook(() => useSidebarHistory());
        state.workspace = "org-1";
        vi.mocked(listTabularReviews).mockResolvedValueOnce([review("org-review")]);
        rerender();
        await waitFor(() => expect(result.current.loading).toBe(false));
        await act(async () => resolve([review("personal-review")]));
        expect(result.current.items.map(({ item }) => item.id)).toEqual(["org-review"]);
        vi.mocked(listTabularReviews).mockResolvedValueOnce([review("updated-review")]);
        act(() => notifyTabularReviewsChanged());
        await waitFor(() => expect(result.current.items.map(({ item }) => item.id)).toEqual(["updated-review"]));
        expect(listTabularReviews).toHaveBeenLastCalledWith(undefined, expect.objectContaining({ workspace: "org-1" }));
    });

    it("keeps chats and every loaded review page visible throughout an activity refresh", async () => {
        state.chats = [{ ...review("chat"), user_id: "u1" } as Chat];
        const firstPage = Array.from({ length: 31 }, (_, i) => review(`r${i}`));
        vi.mocked(listTabularReviews).mockResolvedValueOnce(firstPage).mockResolvedValueOnce([review("last")]);
        const { result } = renderHook(() => useSidebarHistory());
        await waitFor(() => expect(result.current.loading).toBe(false));
        await act(() => result.current.loadMore());
        const before = result.current.items;
        expect(before).toHaveLength(32);

        let resolveFirst!: (rows: TabularReview[]) => void;
        let resolveLast!: (rows: TabularReview[]) => void;
        vi.mocked(listTabularReviews)
            .mockReturnValueOnce(new Promise(done => { resolveFirst = done; }))
            .mockReturnValueOnce(new Promise(done => { resolveLast = done; }));
        act(() => notifyTabularReviewsChanged());
        expect(result.current.loading).toBe(false);
        expect(result.current.items).toBe(before);
        await act(async () => resolveFirst(firstPage.map(row => ({ ...row, is_running: false, is_complete: true }))));
        // Do not expose a partial refresh, which would drop the second page.
        expect(result.current.items).toBe(before);
        expect(listTabularReviews).toHaveBeenLastCalledWith(undefined, expect.objectContaining({ offset: 30 }));
        await act(async () => resolveLast([review("last")]));
        expect(result.current.loading).toBe(false);
        expect(result.current.items).toHaveLength(32);
        expect(result.current.reviews[0].is_complete).toBe(true);
        expect(result.current.hasMore).toBe(false);
    });

    it("keeps loaded rows on a failed activity refresh and discards a refresh from another workspace", async () => {
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        vi.mocked(listTabularReviews).mockResolvedValueOnce([review("personal")]);
        const { result, rerender } = renderHook(() => useSidebarHistory());
        await waitFor(() => expect(result.current.loading).toBe(false));
        vi.mocked(listTabularReviews).mockRejectedValueOnce(new Error("offline"));
        act(() => notifyTabularReviewsChanged());
        await waitFor(() => expect(result.current.error).toBeTruthy());
        expect(result.current.loading).toBe(false);
        expect(result.current.items.map(({ item }) => item.id)).toEqual(["personal"]);

        let resolve!: (rows: TabularReview[]) => void;
        vi.mocked(listTabularReviews).mockReturnValueOnce(new Promise(done => { resolve = done; }));
        act(() => notifyTabularReviewsChanged());
        state.workspace = "org-1";
        vi.mocked(listTabularReviews).mockResolvedValueOnce([review("org-review")]);
        rerender();
        expect(result.current.items).toEqual([]);
        await waitFor(() => expect(result.current.loading).toBe(false));
        await act(async () => resolve([review("stale-personal")]));
        expect(result.current.items.map(({ item }) => item.id)).toEqual(["org-review"]);
        log.mockRestore();
    });

    it("keeps chats usable if review loading fails and permits retry", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        state.chats = [{ ...review("chat"), user_id: "u1" } as Chat];
        vi.mocked(listTabularReviews).mockRejectedValueOnce(new Error("unavailable"));
        const { result } = renderHook(() => useSidebarHistory());
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.items.map(({ item }) => item.id)).toEqual(["chat"]);
        expect(result.current.error).toBeTruthy();
        act(() => { void result.current.retry(); });
        await waitFor(() => expect(result.current.error).toBeNull());
        expect(listTabularReviews).toHaveBeenCalledTimes(2);
        vi.restoreAllMocks();
    });
});
