import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuickAction } from "@/app/components/shared/types";

const scope = vi.hoisted(() => ({ accountId: "u1", workspace: "personal" }));
vi.mock("@/app/contexts/WorkspaceContext", async importOriginal => ({
    ...await importOriginal<typeof import("@/app/contexts/WorkspaceContext")>(),
    useWorkspace: () => ({ accountId: scope.accountId }),
    useDocumentWorkspace: () => scope.workspace,
}));

const { listQuickActions } = vi.hoisted(() => ({
    listQuickActions: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", () => ({
    listQuickActions,
    createQuickAction: vi.fn(),
    updateQuickAction: vi.fn(),
}));

import { useQuickActions } from "./useQuickActions";

const proofread = {
    id: "qa-1",
    enabled: true,
    workflow: { title: "Proofread" },
} as QuickAction;

describe("useQuickActions", () => {
    beforeEach(() => {
        scope.accountId = "u1"; scope.workspace = "personal";
        vi.clearAllMocks();
        window.localStorage.setItem("mike.quickActions.databaseMigrated", "1");
        listQuickActions.mockResolvedValue([proofread]);
    });

    it("waits to load until it is enabled, then loads once", async () => {
        const { result, rerender } = renderHook(
            ({ enabled }) => useQuickActions(enabled),
            { initialProps: { enabled: false } },
        );
        expect(listQuickActions).not.toHaveBeenCalled();

        rerender({ enabled: true });
        await waitFor(() =>
            expect(result.current.quickActions).toEqual([proofread]),
        );

        rerender({ enabled: false });
        rerender({ enabled: true });
        expect(listQuickActions).toHaveBeenCalledTimes(1);
    });
});


it("hides previous actions immediately and ignores delayed loads after workspace/account changes", async () => {
    scope.accountId = "u1"; scope.workspace = "a";
    window.localStorage.setItem("mike.quickActions.databaseMigrated", "1");
    let resolveA!: (actions: QuickAction[]) => void;
    listQuickActions.mockImplementation((_surface, workspace) => workspace === "a" ? new Promise(resolve => { resolveA = resolve; }) : Promise.resolve([]));
    const { result, rerender } = renderHook(() => useQuickActions());
    scope.workspace = "b";
    rerender();
    expect(result.current.quickActions).toEqual([]);
    await act(async () => resolveA([proofread]));
    expect(result.current.quickActions).toEqual([]);
    expect(listQuickActions).toHaveBeenCalledWith("app", "b");
    listQuickActions.mockResolvedValue([proofread]);
    scope.accountId = "u2";
    rerender();
    await waitFor(() => expect(result.current.quickActions).toEqual([proofread]));
    scope.accountId = "u3";
    listQuickActions.mockReturnValue(new Promise(() => {}));
    rerender();
    expect(result.current.quickActions).toEqual([]);
});
