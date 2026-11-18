import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const getSignInOptions = vi.fn();
vi.mock("@/app/lib/authApi", () => ({
    getSignInOptions: () => getSignInOptions(),
}));

import { DEFAULT_SIGN_IN_OPTIONS, useSignInOptions } from "./useSignInOptions";

afterEach(() => {
    getSignInOptions.mockReset();
});

describe("useSignInOptions", () => {
    it("starts unloaded with the defaults, then reports the deployment's options", async () => {
        getSignInOptions.mockResolvedValue({ google: false, sso: false, setupRequired: true });
        const { result } = renderHook(() => useSignInOptions());
        expect(result.current).toEqual({ options: DEFAULT_SIGN_IN_OPTIONS, loaded: false });
        await waitFor(() => expect(result.current.loaded).toBe(true));
        expect(result.current.options).toEqual({ google: false, sso: false, setupRequired: true });
    });

    it("keeps every provider visible when the options cannot be read", async () => {
        getSignInOptions.mockRejectedValue(new Error("offline"));
        const { result } = renderHook(() => useSignInOptions());
        await waitFor(() => expect(result.current.loaded).toBe(true));
        expect(result.current.options).toEqual(DEFAULT_SIGN_IN_OPTIONS);
    });
});
