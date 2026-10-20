import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceSelection } from "./useWorkspaceSelection";
import type { WorkspaceStorage } from "../lib/workspaceSelection";

// The web app's provider runs this hook over localStorage and is covered by
// WorkspaceContext.test.tsx. These cases pin what only an asynchronous
// storage (the Word add-in's OfficeRuntime.storage) can do.

const ACME = { id: "org-acme", name: "Acme LLP" };
const BETA = { id: "org-beta", name: "Beta Chambers" };
const KEY = "mike.activeWorkspace.u1";

function deferredStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    const pending: Array<() => void> = [];
    const storage: WorkspaceStorage = {
        getItem: (key) =>
            new Promise((resolve) =>
                pending.push(() => resolve(values.get(key) ?? null)),
            ),
        setItem: vi.fn(async (key: string, value: string) => {
            values.set(key, value);
        }),
    };
    return {
        storage,
        values,
        /** Answers every read asked so far. */
        answer: () => act(async () => pending.splice(0).forEach((fn) => fn())),
    };
}

let listOrgs: ReturnType<typeof vi.fn<() => Promise<typeof ACME[]>>>;
beforeEach(() => {
    listOrgs = vi.fn(async () => [ACME, BETA]);
});

function renderSelection(
    storage: WorkspaceStorage,
    { userId }: { userId: string | undefined } = { userId: "u1" },
) {
    return renderHook(
        ({ user }) => useWorkspaceSelection({ userId: user, listOrgs, storage }),
        { initialProps: { user: userId } },
    );
}

describe("useWorkspaceSelection with an asynchronous storage", () => {
    it("is not ready, and remembers nothing, until the stored choice is read", async () => {
        const { storage, answer } = deferredStorage({ [KEY]: "org-beta" });
        const { result } = renderSelection(storage);

        expect(result.current.ready).toBe(false);
        expect(result.current.workspaceId).toBe("personal");
        await waitFor(() => expect(result.current.organizations).not.toBeNull());
        expect(storage.setItem).not.toHaveBeenCalled();

        await answer();
        expect(result.current.ready).toBe(true);
        expect(result.current.workspaceId).toBe("org-beta");
        expect(result.current.activeOrganization).toEqual(BETA);
    });

    it("falls back to Personal when the stored organization is already known to be gone", async () => {
        listOrgs.mockResolvedValue([ACME]);
        const { storage, answer, values } = deferredStorage({ [KEY]: "org-beta" });
        const { result } = renderSelection(storage);
        await waitFor(() => expect(result.current.organizations).toEqual([ACME]));

        await answer();
        expect(result.current.workspaceId).toBe("personal");
        await waitFor(() => expect(values.get(KEY)).toBe("personal"));
    });

    it("lets a choice made before the read finishes win", async () => {
        const { storage, answer, values } = deferredStorage({ [KEY]: "org-beta" });
        const { result } = renderSelection(storage);
        await waitFor(() => expect(result.current.organizations).not.toBeNull());

        act(() => result.current.setWorkspace("org-acme"));
        expect(result.current.ready).toBe(true);
        await answer();
        expect(result.current.workspaceId).toBe("org-acme");
        await waitFor(() => expect(values.get(KEY)).toBe("org-acme"));
    });

    it("drops a read that finishes after the account changed", async () => {
        const { storage, answer } = deferredStorage({
            [KEY]: "org-beta",
            "mike.activeWorkspace.u2": "org-acme",
        });
        const { result, rerender } = renderSelection(storage);
        rerender({ user: "u2" });
        await answer();
        await waitFor(() => expect(result.current.workspaceId).toBe("org-acme"));
    });

    it("is Personal and ready with no account, and reads no organizations", () => {
        const { storage } = deferredStorage();
        const { result } = renderSelection(storage, { userId: undefined });
        expect(result.current.ready).toBe(true);
        expect(result.current.workspaceId).toBe("personal");
        act(() => result.current.setWorkspace("org-acme"));
        expect(listOrgs).not.toHaveBeenCalled();
        expect(result.current.workspaceId).toBe("personal");
    });

    it("ignores answers meant for an account that has since signed out", async () => {
        const finishers: Array<(orgs: typeof ACME[]) => void> = [];
        const { storage } = deferredStorage();
        const { result, rerender } = renderSelection(storage);
        await waitFor(() => expect(listOrgs).toHaveBeenCalledTimes(1));
        listOrgs.mockImplementation(
            () => new Promise((resolve) => finishers.push(resolve)),
        );

        let refreshed!: Promise<void>;
        act(() => {
            result.current.setWorkspace("org-new");
            refreshed = result.current.refreshOrganizations();
        });
        rerender({ user: undefined });
        expect(finishers).toHaveLength(2);
        await act(async () =>
            finishers.forEach((finish) => finish([{ id: "org-new", name: "New" }])),
        );
        await act(() => refreshed);

        expect(result.current.workspaceId).toBe("personal");
        expect(result.current.organizations).toBeNull();
    });
});
