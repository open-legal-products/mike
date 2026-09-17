import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listProjects } from "@/app/lib/mikeApi";
import type { Project } from "@/app/components/shared/types";
import { useProjectPicker } from "./useProjectPicker";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    listProjects: vi.fn(),
}));
beforeEach(() => vi.mocked(listProjects).mockReset());

describe("useProjectPicker", () => {
    it("loads on opening, shares an in-flight request, and reuses successful results", async () => {
        let resolve!: (projects: Project[]) => void;
        vi.mocked(listProjects).mockReturnValue(
            new Promise((done) => {
                resolve = done;
            }),
        );
        const { result } = renderHook(() => useProjectPicker());
        expect(listProjects).not.toHaveBeenCalled();
        let pending!: Promise<void>;
        act(() => {
            pending = result.current.openPicker();
            void result.current.openPicker();
        });
        expect(result.current.loading).toBe(true);
        expect(listProjects).toHaveBeenCalledTimes(1);
        await act(async () => {
            resolve([{ id: "p1", name: "Matter" } as Project]);
            await pending;
        });
        act(() => {
            result.current.setSelectedId("p1");
            result.current.closePicker();
        });
        await act(async () => {
            await result.current.openPicker();
        });
        expect(result.current.projects?.[0].name).toBe("Matter");
        expect(result.current.selectedId).toBe("p1");
        expect(listProjects).toHaveBeenCalledTimes(1);
    });

    it("shows a safe error and permits retry instead of caching a failed empty list", async () => {
        vi.mocked(listProjects).mockRejectedValueOnce(
            new Error("private database error"),
        );
        const { result } = renderHook(() => useProjectPicker());
        await act(async () => {
            await result.current.openPicker();
        });
        expect(result.current.error).toBe(
            "Projects could not be loaded. Please try again.",
        );
        expect(result.current.open).toBe(false);
        expect(result.current.projects).toBeNull();
        vi.mocked(listProjects).mockResolvedValue([]);
        await act(async () => {
            await result.current.openPicker();
        });
        expect(result.current.error).toBeNull();
        expect(result.current.open).toBe(true);
        expect(result.current.projects).toEqual([]);
    });
});
