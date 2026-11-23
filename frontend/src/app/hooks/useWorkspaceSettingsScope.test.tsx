import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceSettingsScope } from "./useWorkspaceSettingsScope";

const state = vi.hoisted(() => ({
    workspaceId: "personal" as string | null,
    activeOrganization: null as {
        id: string;
        name: string;
        role: string;
    } | null,
}));

vi.mock("@/app/contexts/WorkspaceContext", () => ({
    PERSONAL_WORKSPACE: "personal",
    useWorkspace: () => state,
}));

const scope = () => renderHook(() => useWorkspaceSettingsScope()).result.current;

beforeEach(() => {
    state.workspaceId = "personal";
    state.activeOrganization = null;
});

describe("useWorkspaceSettingsScope", () => {
    it("is the caller's own in Personal and outside a workspace", () => {
        expect(scope()).toEqual({ kind: "personal" });
        state.workspaceId = null;
        expect(scope()).toEqual({ kind: "personal" });
    });

    it("is not decided before the organization has loaded", () => {
        state.workspaceId = "org-1";
        expect(scope()).toEqual({ kind: "loading" });
    });

    it.each(["owner", "admin"])(
        "is the organization's to manage for its %s",
        (role) => {
            state.workspaceId = "org-1";
            state.activeOrganization = { id: "org-1", name: "Acme LLP", role };
            expect(scope()).toEqual({
                kind: "organization",
                orgId: "org-1",
                orgName: "Acme LLP",
            });
        },
    );

    it("is managed for a member", () => {
        state.workspaceId = "org-1";
        state.activeOrganization = {
            id: "org-1",
            name: "Acme LLP",
            role: "member",
        };
        expect(scope()).toEqual({ kind: "managed", orgName: "Acme LLP" });
    });
});
