import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
    routerSelectionsFromLists,
    useModelRouterSelections,
} from "./useModelRouterSelections";

const mocks = vi.hoisted(() => ({
    profile: null as Record<string, unknown> | null,
    workspaceId: "personal" as string | null,
    orgApiKeys: null as { effective_router_models: unknown } | null,
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: mocks.profile }),
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
    PERSONAL_WORKSPACE: "personal",
    useWorkspace: () => ({
        workspaceId: mocks.workspaceId,
        orgApiKeys: mocks.orgApiKeys,
    }),
}));

beforeEach(() => {
    mocks.profile = {
        openRouterModels: ["mine/or-model"],
        vercelModels: ["mine/vercel-model"],
    };
    mocks.workspaceId = "personal";
    mocks.orgApiKeys = null;
});

describe("routerSelectionsFromLists", () => {
    it("has a list for every router and drops anything that is not a model id", () => {
        const selections = routerSelectionsFromLists({
            openrouter: ["a/one", 7, null, "b/two"],
            bedrock: "not-a-list",
            unknown: ["x"],
        });
        expect(selections.openrouter).toEqual(["a/one", "b/two"]);
        expect(selections.bedrock).toEqual([]);
        expect(selections.vercel).toEqual([]);
        expect(selections).not.toHaveProperty("unknown");
    });

    it("is all empty for a missing answer", () => {
        expect(routerSelectionsFromLists(undefined).openrouter).toEqual([]);
    });
});

describe("useModelRouterSelections", () => {
    it("is the caller's own lists in the personal workspace", () => {
        const { result } = renderHook(() => useModelRouterSelections());
        expect(result.current?.openrouter).toEqual(["mine/or-model"]);
        expect(result.current?.vercel).toEqual(["mine/vercel-model"]);
    });

    it("is unknown until the profile has loaded", () => {
        mocks.profile = null;
        expect(
            renderHook(() => useModelRouterSelections()).result.current,
        ).toBeUndefined();
    });

    it("is the server's answer for the organization in its workspace", () => {
        mocks.workspaceId = "org-1";
        // The organization holds an OpenRouter key, so its list replaces the
        // member's there; the member's Vercel list stands.
        mocks.orgApiKeys = {
            effective_router_models: {
                openrouter: ["firm/approved"],
                vercel: ["mine/vercel-model"],
            },
        };

        const { result } = renderHook(() => useModelRouterSelections());

        expect(result.current?.openrouter).toEqual(["firm/approved"]);
        expect(result.current?.vercel).toEqual(["mine/vercel-model"]);
    });

    it("is unknown, not the caller's own, until the organization's lists arrive", () => {
        mocks.workspaceId = "org-1";
        expect(
            renderHook(() => useModelRouterSelections()).result.current,
        ).toBeUndefined();
    });
});
