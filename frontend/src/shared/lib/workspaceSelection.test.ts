import { describe, expect, it, vi } from "vitest";
import {
    PERSONAL_WORKSPACE,
    PERSONAL_WORKSPACE_LABEL,
    isKnownWorkspace,
    readStoredWorkspace,
    readStoredWorkspaceNow,
    requestWorkspaceSwitch,
    resolveWorkspace,
    storeWorkspace,
    workspaceIdentityKey,
    workspaceMenuOptions,
    workspaceName,
    workspaceOrgId,
    workspaceStorageKey,
    type WorkspaceStorage,
} from "./workspaceSelection";

const ACME = { id: "org-acme", name: "Acme LLP" };
const BETA = { id: "org-beta", name: "Beta Chambers" };

function memoryStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return {
        values,
        sync: {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => {
                values.set(key, value);
            },
        } satisfies WorkspaceStorage,
        async: {
            getItem: async (key: string) => values.get(key) ?? null,
            setItem: async (key: string, value: string) => {
                values.set(key, value);
            },
        } satisfies WorkspaceStorage,
    };
}

const throwing: WorkspaceStorage = {
    getItem: () => {
        throw new Error("blocked");
    },
    setItem: () => {
        throw new Error("blocked");
    },
};
const rejecting: WorkspaceStorage = {
    getItem: () => Promise.reject(new Error("blocked")),
    setItem: () => Promise.reject(new Error("blocked")),
};

describe("workspace storage", () => {
    it("keeps the key existing web users' choice is stored under", () => {
        expect(workspaceStorageKey("u1")).toBe("mike.activeWorkspace.u1");
    });

    it("reads a synchronous storage at once", () => {
        const { sync } = memoryStorage({ "mike.activeWorkspace.u1": "org-acme" });
        expect(readStoredWorkspaceNow(sync, "u1")).toBe("org-acme");
        expect(readStoredWorkspaceNow(sync, "u2")).toBe(PERSONAL_WORKSPACE);
    });

    it("says an asynchronous storage cannot answer at once", () => {
        const { async } = memoryStorage({ "mike.activeWorkspace.u1": "org-acme" });
        expect(readStoredWorkspaceNow(async, "u1")).toBeUndefined();
        expect(readStoredWorkspaceNow(rejecting, "u1")).toBeUndefined();
    });

    it("is Personal with no account or a storage that throws", async () => {
        const { sync } = memoryStorage();
        expect(readStoredWorkspaceNow(sync, undefined)).toBe(PERSONAL_WORKSPACE);
        expect(readStoredWorkspaceNow(throwing, "u1")).toBe(PERSONAL_WORKSPACE);
        expect(await readStoredWorkspace(sync, null)).toBe(PERSONAL_WORKSPACE);
        expect(await readStoredWorkspace(throwing, "u1")).toBe(PERSONAL_WORKSPACE);
        expect(await readStoredWorkspace(rejecting, "u1")).toBe(PERSONAL_WORKSPACE);
    });

    it("reads either kind of storage asynchronously", async () => {
        const { sync, async } = memoryStorage({
            "mike.activeWorkspace.u1": "org-acme",
        });
        expect(await readStoredWorkspace(sync, "u1")).toBe("org-acme");
        expect(await readStoredWorkspace(async, "u1")).toBe("org-acme");
        expect(await readStoredWorkspace(async, "u2")).toBe(PERSONAL_WORKSPACE);
    });

    it("writes a synchronous storage before returning", () => {
        const { sync, values } = memoryStorage();
        void storeWorkspace(sync, "u1", "org-beta");
        expect(values.get("mike.activeWorkspace.u1")).toBe("org-beta");
    });

    it("remembers nothing without an account and never rejects", async () => {
        const { async, values } = memoryStorage();
        await storeWorkspace(async, undefined, "org-beta");
        expect(values.size).toBe(0);
        await storeWorkspace(async, "u1", "org-beta");
        expect(values.get("mike.activeWorkspace.u1")).toBe("org-beta");
        await expect(storeWorkspace(throwing, "u1", "x")).resolves.toBeUndefined();
        await expect(storeWorkspace(rejecting, "u1", "x")).resolves.toBeUndefined();
    });
});

describe("resolveWorkspace", () => {
    it("is Personal for Personal", () => {
        expect(resolveWorkspace(PERSONAL_WORKSPACE, [ACME])).toEqual({
            workspaceId: PERSONAL_WORKSPACE,
            activeOrganization: null,
        });
    });

    it("keeps an organization while the list is not loaded", () => {
        expect(resolveWorkspace("org-acme", null)).toEqual({
            workspaceId: "org-acme",
            activeOrganization: null,
        });
    });

    it("names the organization once the list has it", () => {
        expect(resolveWorkspace("org-acme", [ACME, BETA])).toEqual({
            workspaceId: "org-acme",
            activeOrganization: ACME,
        });
    });

    it("falls back to Personal when the organization is gone", () => {
        expect(resolveWorkspace("org-acme", [BETA])).toEqual({
            workspaceId: PERSONAL_WORKSPACE,
            activeOrganization: null,
        });
    });
});

describe("requestWorkspaceSwitch", () => {
    function handlers() {
        return { select: vi.fn(), organizationsLoaded: vi.fn() };
    }

    it("selects a known workspace at once, without reading the list", () => {
        const listOrgs = vi.fn();
        const h = handlers();
        void requestWorkspaceSwitch("org-acme", [ACME], listOrgs, h);
        void requestWorkspaceSwitch(PERSONAL_WORKSPACE, null, listOrgs, h);
        expect(h.select.mock.calls).toEqual([["org-acme"], [PERSONAL_WORKSPACE]]);
        expect(listOrgs).not.toHaveBeenCalled();
        expect(isKnownWorkspace("org-beta", [ACME])).toBe(false);
    });

    it("reads the list once and switches to an organization just joined", async () => {
        const h = handlers();
        await requestWorkspaceSwitch("org-beta", [ACME], async () => [ACME, BETA], h);
        expect(h.organizationsLoaded).toHaveBeenCalledWith([ACME, BETA]);
        expect(h.select).toHaveBeenCalledWith("org-beta");
    });

    it("does not switch to a stranger's organization", async () => {
        const h = handlers();
        await requestWorkspaceSwitch("org-x", [ACME], async () => [ACME], h);
        expect(h.organizationsLoaded).toHaveBeenCalledWith([ACME]);
        expect(h.select).not.toHaveBeenCalled();
    });

    it("switches nothing when the list cannot be read or there is no account", async () => {
        const h = handlers();
        await requestWorkspaceSwitch(
            "org-beta",
            null,
            () => Promise.reject(new Error("offline")),
            h,
        );
        await requestWorkspaceSwitch("org-beta", null, undefined, h);
        expect(h.organizationsLoaded).not.toHaveBeenCalled();
        expect(h.select).not.toHaveBeenCalled();
    });
});

describe("workspace ids", () => {
    it("files work under an organization only outside Personal", () => {
        expect(workspaceOrgId("org-acme")).toBe("org-acme");
        expect(workspaceOrgId(PERSONAL_WORKSPACE)).toBeUndefined();
        expect(workspaceOrgId(null)).toBeUndefined();
        expect(workspaceOrgId(undefined)).toBeUndefined();
    });

    it("keys ephemeral state by account and workspace, Personal by default", () => {
        expect(workspaceIdentityKey("u1", "org-acme")).toBe('["u1","org-acme"]');
        expect(workspaceIdentityKey(undefined, undefined)).toBe(
            '[null,"personal"]',
        );
    });

    it("offers Personal and each organization only when there is a choice", () => {
        expect(workspaceMenuOptions(null)).toBeNull();
        expect(workspaceMenuOptions([])).toBeNull();
        expect(
            workspaceMenuOptions([{ ...ACME, role: "member" } as typeof ACME]),
        ).toEqual([
            { id: PERSONAL_WORKSPACE, name: PERSONAL_WORKSPACE_LABEL },
            ACME,
        ]);
    });

    it("names a workspace, or nothing when it is unknown", () => {
        expect(workspaceName(PERSONAL_WORKSPACE, null)).toBe("Personal");
        expect(workspaceName("org-acme", [ACME])).toBe("Acme LLP");
        expect(workspaceName("org-x", [ACME])).toBe("");
        expect(workspaceName("org-x", null)).toBe("");
    });
});
