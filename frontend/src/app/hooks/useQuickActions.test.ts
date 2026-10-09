import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuickAction } from "@/app/components/shared/types";

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
