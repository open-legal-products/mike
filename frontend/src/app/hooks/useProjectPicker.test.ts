import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listProjects } from "@/app/lib/mikeApi";
import type { Project } from "@/app/components/shared/types";
import { useProjectPicker } from "./useProjectPicker";

const workspace = vi.hoisted(() => ({ current: "personal" }));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
    useWorkspaceParam: () => workspace.current,
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    listProjects: vi.fn(),
}));
beforeEach(() => {
    vi.mocked(listProjects).mockReset();
    workspace.current = "personal";
});

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
        act(() => {
            result.current.openPicker();
            result.current.openPicker();
        });
        expect(result.current.loading).toBe(true);
        expect(listProjects).toHaveBeenCalledTimes(1);
        expect(listProjects).toHaveBeenCalledWith({ participatingOnly: true, workspace: "personal" });
        await act(async () => {
            resolve([{ id: "p1", name: "Matter" } as Project]);
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

    it("discards cached rows and selection and reloads an open picker on workspace switches", async () => {
        vi.mocked(listProjects).mockResolvedValue([{ id: "personal-project" } as Project]);
        const { result, rerender } = renderHook(() => useProjectPicker());
        act(() => result.current.openPicker());
        await waitFor(() => expect(result.current.loading).toBe(false));
        act(() => result.current.setSelectedId("personal-project"));

        let resolve!: (projects: Project[]) => void;
        vi.mocked(listProjects).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
        workspace.current = "org-1";
        rerender();
        expect(result.current.projects).toBeNull();
        expect(result.current.selectedId).toBeNull();
        expect(result.current.loading).toBe(true);
        expect(listProjects).toHaveBeenLastCalledWith({ participatingOnly: true, workspace: "org-1" });
        const orgProjects = [
            { id: "org-public", org_id: "org-1", access_scope: "organization" },
            { id: "org-private", org_id: "org-1", access_scope: "private" },
            { id: "org-shared-private", org_id: "org-1", access_scope: "shared" },
        ] as Project[];
        await act(async () => resolve(orgProjects));
        expect(result.current.projects).toEqual(orgProjects);

        workspace.current = "personal";
        rerender();
        expect(result.current.projects).toBeNull();
        expect(result.current.selectedId).toBeNull();
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.projects?.[0].id).toBe("personal-project");
        expect(listProjects).toHaveBeenCalledTimes(3);
    });

    it.each(["resolve", "reject"])("ignores a stale request's %s after switching workspace", async (outcome) => {
        let resolve!: (projects: Project[]) => void;
        let reject!: (reason: Error) => void;
        vi.mocked(listProjects).mockReturnValueOnce(new Promise((done, fail) => {
            resolve = done;
            reject = fail;
        }));
        const { result, rerender } = renderHook(() => useProjectPicker());
        act(() => result.current.openPicker());
        vi.mocked(listProjects).mockResolvedValue([{ id: "org-project" } as Project]);
        workspace.current = "org-1";
        rerender();
        await waitFor(() => expect(result.current.loading).toBe(false));
        await act(async () => {
            if (outcome === "resolve") resolve([{ id: "personal-project" } as Project]);
            else reject(new Error("old workspace failed"));
        });
        expect(result.current.projects?.[0].id).toBe("org-project");
        expect(result.current.error).toBeNull();
        expect(result.current.open).toBe(true);
    });

    it("invalidates a closed picker's cache without loading until it opens", async () => {
        vi.mocked(listProjects).mockResolvedValue([{ id: "personal-project" } as Project]);
        const { result, rerender } = renderHook(() => useProjectPicker());
        act(() => result.current.openPicker());
        await waitFor(() => expect(result.current.loading).toBe(false));
        act(() => {
            result.current.setSelectedId("personal-project");
            result.current.closePicker();
        });
        workspace.current = "org-1";
        rerender();
        expect(result.current.projects).toBeNull();
        expect(result.current.selectedId).toBeNull();
        expect(result.current.open).toBe(false);
        expect(listProjects).toHaveBeenCalledTimes(1);
        vi.mocked(listProjects).mockResolvedValue([]);
        act(() => result.current.openPicker());
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(listProjects).toHaveBeenLastCalledWith({ participatingOnly: true, workspace: "org-1" });
        expect(result.current.projects).toEqual([]);
    });
});
