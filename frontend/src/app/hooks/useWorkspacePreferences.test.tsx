import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgPreferences } from "@/app/lib/mikeApi";
import { useWorkspacePreferences } from "./useWorkspacePreferences";

const state = vi.hoisted(() => ({
    profile: null as Record<string, unknown> | null,
    workspaceId: "personal" as string | null,
    orgPreferences: null as Partial<OrgPreferences> | null,
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useOptionalUserProfile: () =>
        state.profile ? { profile: state.profile } : undefined,
}));

vi.mock("@/app/contexts/WorkspaceContext", () => ({
    PERSONAL_WORKSPACE: "personal",
    useWorkspace: () => ({
        workspaceId: state.workspaceId,
        orgPreferences: state.orgPreferences,
    }),
}));

const ORG: Partial<OrgPreferences> = {
    quick_actions_visible: false,
    response_details_visible: true,
    tabular_model: "org-model",
};

beforeEach(() => {
    state.profile = {
        quickActionsVisible: true,
        responseDetailsVisible: false,
        tabularModel: "my-model",
    };
    state.workspaceId = "personal";
    state.orgPreferences = ORG;
});

describe("useWorkspacePreferences", () => {
    it("follows the caller's own settings in Personal", () => {
        expect(renderHook(() => useWorkspacePreferences()).result.current).toEqual({
            governedByOrganization: false,
            quickActionsVisible: true,
            responseDetailsVisible: false,
            tabularModel: "my-model",
        });
    });

    it("follows the organization's settings in its workspace, not the caller's", () => {
        state.workspaceId = "org-1";
        expect(renderHook(() => useWorkspacePreferences()).result.current).toEqual({
            governedByOrganization: true,
            quickActionsVisible: false,
            responseDetailsVisible: true,
            tabularModel: "org-model",
        });
    });

    it("knows nothing in an organization until its settings arrive", () => {
        state.workspaceId = "org-1";
        state.orgPreferences = null;
        expect(renderHook(() => useWorkspacePreferences()).result.current).toEqual({
            governedByOrganization: true,
            quickActionsVisible: undefined,
            responseDetailsVisible: undefined,
            tabularModel: undefined,
        });
    });

    it("knows nothing in Personal until the profile arrives", () => {
        state.profile = null;
        expect(renderHook(() => useWorkspacePreferences()).result.current).toEqual({
            governedByOrganization: false,
            quickActionsVisible: undefined,
            responseDetailsVisible: undefined,
            tabularModel: undefined,
        });
    });

    it("reads as Personal outside a workspace provider", () => {
        state.workspaceId = null;
        expect(
            renderHook(() => useWorkspacePreferences()).result.current
                .tabularModel,
        ).toBe("my-model");
    });
});
