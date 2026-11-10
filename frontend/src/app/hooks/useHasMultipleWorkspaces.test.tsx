import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasMultipleWorkspaces } from "./useHasMultipleWorkspaces";

const state = vi.hoisted(() => ({
    organizations: null as { id: string; name: string }[] | null,
}));

vi.mock("@/app/contexts/WorkspaceContext", () => ({
    useWorkspace: () => ({ organizations: state.organizations }),
}));

beforeEach(() => {
    state.organizations = null;
});

describe("useHasMultipleWorkspaces", () => {
    it("is false until the organizations have loaded", () => {
        expect(renderHook(() => useHasMultipleWorkspaces()).result.current).toBe(
            false,
        );
    });

    it("is false for someone with only Personal", () => {
        state.organizations = [];
        expect(renderHook(() => useHasMultipleWorkspaces()).result.current).toBe(
            false,
        );
    });

    it("is true once they belong to an organization", () => {
        state.organizations = [{ id: "org-1", name: "Acme LLP" }];
        expect(renderHook(() => useHasMultipleWorkspaces()).result.current).toBe(
            true,
        );
    });
});
