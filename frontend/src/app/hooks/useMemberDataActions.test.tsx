import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMemberDataActions } from "./useMemberDataActions";

const state = vi.hoisted(() => ({
    workspaceId: "personal" as string | null,
    activeOrganization: null as Record<string, unknown> | null,
}));

vi.mock("@/app/contexts/WorkspaceContext", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/contexts/WorkspaceContext")>()),
    useWorkspace: () => state,
}));

const actions = () => renderHook(() => useMemberDataActions()).result.current;
const inOrg = (org: Record<string, unknown>) => {
    state.workspaceId = "org-1";
    state.activeOrganization = { id: "org-1", name: "Acme LLP", ...org };
};

beforeEach(() => {
    state.workspaceId = "personal";
    state.activeOrganization = null;
});

describe("useMemberDataActions", () => {
    it("allows everything in Personal", () => {
        expect(actions()).toEqual({ canExport: true, canDelete: true });
    });

    it("allows everything outside a workspace provider", () => {
        state.workspaceId = null;
        expect(actions()).toEqual({ canExport: true, canDelete: true });
    });

    it("allows an organization's owners everything", () => {
        inOrg({ role: "owner", allow_member_exports: false, allow_member_deletes: false });
        expect(actions()).toEqual({ canExport: true, canDelete: true });
    });

    it("allows other members only what the owners allow", () => {
        inOrg({ role: "admin", allow_member_exports: true, allow_member_deletes: false });
        expect(actions()).toEqual({ canExport: true, canDelete: false });
    });

    it("allows nothing when the organization says nothing", () => {
        inOrg({ role: "member" });
        expect(actions()).toEqual({ canExport: false, canDelete: false });
    });

    it("allows nothing while the organization is loading", () => {
        state.workspaceId = "org-1";
        expect(actions()).toEqual({ canExport: false, canDelete: false });
    });
});
