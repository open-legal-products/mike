import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/app/lib/authEvents";
import { invalidateDocxBytes, useFetchDocxBytes } from "./useFetchDocxBytes";

vi.mock("@/app/lib/authEvents", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("@/app/lib/mikeApi", () => ({ getDocumentFileUrl: (id: string) => `/file/${id}` }));

it("does not let a pre-save fetch repopulate the cache with stale document bytes", async () => {
    let finishOld!: (value: Response) => void;
    vi.mocked(authenticatedFetch)
        .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
        .mockResolvedValueOnce(new Response(new Uint8Array([2])));
    const old = renderHook(() => useFetchDocxBytes("saved-doc", "v1"));
    invalidateDocxBytes("saved-doc");
    const reopened = renderHook(() => useFetchDocxBytes("saved-doc", "v1"));
    await waitFor(() => expect(reopened.result.current.bytes).not.toBeNull());
    expect(new Uint8Array(reopened.result.current.bytes!)).toEqual(new Uint8Array([2]));
    await act(async () => finishOld(new Response(new Uint8Array([1]))));
    old.unmount();
    reopened.unmount();
    const again = renderHook(() => useFetchDocxBytes("saved-doc", "v1"));
    expect(new Uint8Array(again.result.current.bytes!)).toEqual(new Uint8Array([2]));
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
});
