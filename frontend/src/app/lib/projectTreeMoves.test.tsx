import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/app/components/shared/types";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";
import {
    moveProjectItemOptimistically,
    notifyMoveFailure,
    withItemParent,
} from "./projectTreeMoves";

function store(initial: Project) {
    let state: Project | null = initial;
    return {
        get: () => state,
        set: vi.fn((update: (current: Project | null) => Project | null) => {
            state = update(state);
        }),
    };
}

const project = {
    id: "p1",
    name: "Matter",
    documents: [{ id: "d1", folder_id: "f1" }],
    folders: [
        { id: "f1", parent_folder_id: null },
        { id: "f2", parent_folder_id: "f1" },
    ],
} as unknown as Project;

describe("moveProjectItemOptimistically", () => {
    it("shows the move at once and keeps it when the request succeeds", async () => {
        const s = store(project);
        await moveProjectItemOptimistically({
            project: s.get(),
            setProject: s.set,
            kind: "doc",
            id: "d1",
            targetFolderId: null,
            request: async () => undefined,
        });
        expect(s.get()?.documents?.[0]?.folder_id).toBeNull();
    });

    it("puts a document back where it was when the move fails, and rethrows", async () => {
        const s = store(project);
        const failure = new Error("boom");
        await expect(
            moveProjectItemOptimistically({
                project: s.get(),
                setProject: s.set,
                kind: "doc",
                id: "d1",
                targetFolderId: null,
                request: async () => {
                    throw failure;
                },
            }),
        ).rejects.toBe(failure);
        expect(s.get()?.documents?.[0]?.folder_id).toBe("f1");
    });

    it("puts a folder back, but never undoes a later move of the same item", async () => {
        const s = store(project);
        let reject: (error: Error) => void = () => {};
        const pending = moveProjectItemOptimistically({
            project: s.get(),
            setProject: s.set,
            kind: "folder",
            id: "f2",
            targetFolderId: null,
            request: () =>
                new Promise((_, rej) => {
                    reject = rej;
                }),
        });
        // The user moves it again before the first request fails.
        s.set((current) => ({
            ...current!,
            folders: current!.folders!.map((f) =>
                f.id === "f2" ? { ...f, parent_folder_id: "f9" } : f,
            ),
        }));
        reject(new Error("boom"));
        await expect(pending).rejects.toThrow("boom");
        expect(
            s.get()?.folders?.find((f) => f.id === "f2")?.parent_folder_id,
        ).toBe("f9");
    });
});

describe("withItemParent", () => {
    it("leaves an unloaded project alone", () => {
        expect(withItemParent(null, "doc", "d1", null)).toBeNull();
    });

    it("re-parents only the named item, treating a missing parent as the root", () => {
        const sparse = {
            id: "p1",
            documents: [{ id: "d1" }, { id: "d2", folder_id: "f1" }],
            folders: [{ id: "f1" }, { id: "f2" }],
        } as unknown as Project;

        const docs = withItemParent(sparse, "doc", "d1", "f1", null);
        expect(docs?.documents?.map((d) => d.folder_id)).toEqual(["f1", "f1"]);

        const folders = withItemParent(sparse, "folder", "f2", "f1", null);
        expect(folders?.folders?.map((f) => f.parent_folder_id)).toEqual([
            undefined,
            "f1",
        ]);
    });

    it("does nothing when the item is no longer where the change expects it", () => {
        expect(withItemParent(project, "doc", "d1", null, "f9")).toBe(project);
        expect(withItemParent(project, "folder", "missing", null, null)).toBe(
            project,
        );
        expect(withItemParent(project, "doc", "missing", null, null)).toBe(
            project,
        );
    });

    it("copes with a project that has no document or folder lists", () => {
        const empty = { id: "p1" } as unknown as Project;
        expect(withItemParent(empty, "doc", "d1", null)?.documents).toEqual([]);
        expect(withItemParent(empty, "folder", "f1", null)?.folders).toEqual([]);
        // A conditional change finds nothing to move in either list.
        expect(withItemParent(empty, "doc", "d1", null, null)).toBe(empty);
        expect(withItemParent(empty, "folder", "f1", null, null)).toBe(empty);
    });
});

describe("moveProjectItemOptimistically without a known starting place", () => {
    it("rethrows without reverting when the item was not in the loaded project", async () => {
        const s = store(project);
        await expect(
            moveProjectItemOptimistically({
                project: null,
                setProject: s.set,
                kind: "doc",
                id: "d1",
                targetFolderId: null,
                request: async () => {
                    throw new Error("boom");
                },
            }),
        ).rejects.toThrow("boom");
        // Only the optimistic write: there was no previous place to restore.
        expect(s.set).toHaveBeenCalledTimes(1);
    });
});

describe("notifyMoveFailure", () => {
    afterEach(() => clearToasts());

    it.each([
        ["doc", "Couldn't move this document"],
        ["folder", "Couldn't move this folder"],
    ] as const)("names the %s and retries the move", (kind, title) => {
        render(<ToastViewportUI />);
        const retry = vi.fn();
        act(() => {
            notifyMoveFailure(kind, "x1", new TypeError("Failed to fetch"), retry);
        });
        expect(screen.getByRole("alert")).toHaveTextContent(title);
        act(() => {
            screen.getByRole("button", { name: "Retry" }).click();
        });
        expect(retry).toHaveBeenCalledOnce();
    });
});
