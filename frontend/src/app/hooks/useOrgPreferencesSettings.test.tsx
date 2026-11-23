import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOrgPreferencesSettings } from "./useOrgPreferencesSettings";

const mocks = vi.hoisted(() => ({
    orgPreferences: null as Record<string, unknown> | null,
    loadOrgPreferences: vi.fn(),
    saveOrgPreferences: vi.fn(),
}));

vi.mock("@/app/contexts/WorkspaceContext", () => ({
    useWorkspace: () => ({
        orgPreferences: mocks.orgPreferences,
        loadOrgPreferences: mocks.loadOrgPreferences,
        saveOrgPreferences: mocks.saveOrgPreferences,
    }),
}));

beforeEach(() => {
    vi.clearAllMocks();
    mocks.orgPreferences = null;
    mocks.loadOrgPreferences.mockResolvedValue({ tabular_model: "fresh" });
    mocks.saveOrgPreferences.mockResolvedValue({ tabular_model: "saved" });
});

describe("useOrgPreferencesSettings", () => {
    it("reads the organization's preferences afresh through the workspace", async () => {
        renderHook(() => useOrgPreferencesSettings("org-1"));
        await waitFor(() =>
            expect(mocks.loadOrgPreferences).toHaveBeenCalledWith(
                "org-1",
                expect.any(AbortSignal),
            ),
        );
    });

    it("saves through the workspace, which shares the answer app-wide", async () => {
        const { result } = renderHook(() => useOrgPreferencesSettings("org-1"));
        await expect(
            result.current.save({ tabular_model: "saved" }),
        ).resolves.toEqual({ tabular_model: "saved" });
        expect(mocks.saveOrgPreferences).toHaveBeenCalledWith("org-1", {
            tabular_model: "saved",
        });
    });

    it("lets a refused save reject, for the page to report", async () => {
        const refusal = new Error("refused");
        mocks.saveOrgPreferences.mockRejectedValueOnce(refusal);
        const { result } = renderHook(() => useOrgPreferencesSettings("org-1"));
        await expect(
            result.current.save({ tabular_model: "x" }),
        ).rejects.toBe(refusal);
    });

    it("says the read failed only when there is no copy to show, and retries", async () => {
        mocks.loadOrgPreferences.mockRejectedValueOnce(new Error("network"));
        const { result } = renderHook(() => useOrgPreferencesSettings("org-1"));
        await waitFor(() => expect(result.current.loadError).toBe(true));

        act(() => result.current.retry());
        expect(result.current.loadError).toBe(false);
        await waitFor(() =>
            expect(mocks.loadOrgPreferences).toHaveBeenCalledTimes(2),
        );
    });

    it("keeps showing a copy already in hand when a re-read fails", async () => {
        mocks.orgPreferences = { tabular_model: "known" };
        mocks.loadOrgPreferences.mockRejectedValueOnce(new Error("network"));
        const { result } = renderHook(() => useOrgPreferencesSettings("org-1"));
        await waitFor(() =>
            expect(mocks.loadOrgPreferences).toHaveBeenCalled(),
        );
        expect(result.current.loadError).toBe(false);
        expect(result.current.preferences).toEqual({ tabular_model: "known" });
    });

    it("ignores the answer of a read abandoned on unmount", async () => {
        let resolve: (value: unknown) => void = () => {};
        mocks.loadOrgPreferences.mockReturnValueOnce(
            new Promise((r) => {
                resolve = r;
            }),
        );
        const { unmount } = renderHook(() => useOrgPreferencesSettings("org-1"));
        unmount();
        resolve({ tabular_model: "late" });
    });
});
