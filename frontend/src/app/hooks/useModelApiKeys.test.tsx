import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { API_KEY_PROVIDERS, apiKeyStateFromStatus } from "@/app/lib/apiKeyState";
import type { ApiKeyStatus } from "@/app/lib/mikeApi";
import { useModelApiKeys } from "./useModelApiKeys";

const mocks = vi.hoisted(() => ({
    profile: null as { apiKeys: unknown } | null,
    apiKeysDegraded: false,
    workspaceId: "personal" as string | null,
    orgApiKeys: null as { effective: unknown } | null,
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: mocks.profile,
        apiKeysDegraded: mocks.apiKeysDegraded,
    }),
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
    PERSONAL_WORKSPACE: "personal",
    useWorkspace: () => ({
        workspaceId: mocks.workspaceId,
        orgApiKeys: mocks.orgApiKeys,
    }),
}));

const status = (overrides: Partial<ApiKeyStatus>): ApiKeyStatus =>
    ({
        ...Object.fromEntries(API_KEY_PROVIDERS.map((p) => [p, false])),
        ...overrides,
    }) as ApiKeyStatus;

const PERSONAL = apiKeyStateFromStatus(
    status({ claude: true, sources: { claude: "user" } }),
);
const ORG_EFFECTIVE = status({ openai: true, sources: { openai: "org" } });

beforeEach(() => {
    mocks.profile = { apiKeys: PERSONAL };
    mocks.apiKeysDegraded = false;
    mocks.workspaceId = "personal";
    mocks.orgApiKeys = null;
});

describe("useModelApiKeys", () => {
    it("is the caller's own keys in the personal workspace", () => {
        expect(renderHook(() => useModelApiKeys()).result.current).toBe(PERSONAL);
    });

    it("is the caller's own keys outside a workspace provider", () => {
        mocks.workspaceId = null;
        expect(renderHook(() => useModelApiKeys()).result.current).toBe(PERSONAL);
    });

    it("is unknown when the profile's keys failed to load", () => {
        mocks.apiKeysDegraded = true;
        expect(renderHook(() => useModelApiKeys()).result.current).toBeUndefined();
    });

    it("is the organization's answer in an organization workspace", () => {
        mocks.workspaceId = "org-1";
        mocks.orgApiKeys = { effective: ORG_EFFECTIVE };

        const keys = renderHook(() => useModelApiKeys()).result.current;

        // The member's own Claude key is not what this workspace runs on.
        expect(keys?.openai).toMatchObject({ configured: true, source: "org" });
        expect(keys?.claude.configured).toBe(false);
    });

    it("is unknown, not the caller's own, until the organization's keys arrive", () => {
        // Falling back to personal keys here would offer models the
        // organization cannot run, then take them away a moment later.
        mocks.workspaceId = "org-1";
        expect(renderHook(() => useModelApiKeys()).result.current).toBeUndefined();
    });

    it("does not depend on the profile in an organization workspace", () => {
        mocks.workspaceId = "org-1";
        mocks.orgApiKeys = { effective: ORG_EFFECTIVE };
        mocks.apiKeysDegraded = true;
        expect(
            renderHook(() => useModelApiKeys()).result.current?.openai.configured,
        ).toBe(true);
    });
});
