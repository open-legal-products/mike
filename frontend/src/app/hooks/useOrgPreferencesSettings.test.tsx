import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOrgPreferencesSettings } from "./useOrgPreferencesSettings";

const mocks = vi.hoisted(() => ({
    orgPreferences: null as Record<string, unknown> | null,
    setOrgPreferences: vi.fn(),
    getOrgPreferences: vi.fn(),
    updateOrgPreferences: vi.fn(),
}));

vi.mock("@/app/contexts/WorkspaceContext", () => ({
    useWorkspace: () => ({
        orgPreferences: mocks.orgPreferences,
        setOrgPreferences: mocks.setOrgPreferences,
    }),
}));
vi.mock("@/app/lib/mikeApi", () => ({
    getOrgPreferences: mocks.getOrgPreferences,
    updateOrgPreferences: mocks.updateOrgPreferences,
}));

beforeEach(() => {
    vi.clearAllMocks();
    mocks.orgPreferences = null;
    mocks.getOrgPreferences.mockResolvedValue({ tabular_model: "fresh" });
    mocks.updateOrgPreferences.mockResolvedValue({ tabular_model: "saved" });
});

describe("useOrgPreferencesSettings", () => {
    it("reads the organization's preferences afresh and shares them app-wide", async () => {
        renderHook(() => useOrgPreferencesSettings("org-1"));
        await waitFor(() =>
            expect(mocks.setOrgPreferences).toHaveBeenCalledWith("org-1", {
                tabular_model: "fresh",
            }),
        );
        expect(mocks.getOrgPreferences).toHaveBeenCalledWith(
            "org-1",
            expect.any(AbortSignal),
        );
    });

    it("puts a saved answer in place app-wide", async () => {
        const { result } = renderHook(() => useOrgPreferencesSettings("org-1"));
        await act(() => result.current.save({ tabular_model: "saved" }));
        expect(mocks.updateOrgPreferences).toHaveBeenCalledWith("org-1", {
            tabular_model: "saved",
        });
        expect(mocks.setOrgPreferences).toHaveBeenLastCalledWith("org-1", {
            tabular_model: "saved",
        });
    });

    it("lets a refused save reject, for the page to report", async () => {
        const refusal = new Error("refused");
        mocks.updateOrgPreferences.mockRejectedValueOnce(refusal);
        const { result } = renderHook(() => useOrgPreferencesSettings("org-1"));
        await expect(
            result.current.save({ tabular_model: "x" }),
        ).rejects.toBe(refusal);
    });

    it("says the read failed only when there is no copy to show, and retries", async () => {
        mocks.getOrgPreferences.mockRejectedValueOnce(new Error("network"));
        const { result } = renderHook(() => useOrgPreferencesSettings("org-1"));
        await waitFor(() => expect(result.current.loadError).toBe(true));

        act(() => result.current.retry());
        expect(result.current.loadError).toBe(false);
        await waitFor(() =>
            expect(mocks.getOrgPreferences).toHaveBeenCalledTimes(2),
        );
    });

    it("keeps showing a copy already in hand when a re-read fails", async () => {
        mocks.orgPreferences = { tabular_model: "known" };
        mocks.getOrgPreferences.mockRejectedValueOnce(new Error("network"));
        const { result } = renderHook(() => useOrgPreferencesSettings("org-1"));
        await waitFor(() =>
            expect(mocks.getOrgPreferences).toHaveBeenCalled(),
        );
        expect(result.current.loadError).toBe(false);
        expect(result.current.preferences).toEqual({ tabular_model: "known" });
    });
});
