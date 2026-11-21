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

it("cache regression: evicts least recently viewed previews to respect the byte budget", async () => {
    const fetch = vi.mocked(authenticatedFetch);
    fetch.mockClear();
    fetch.mockImplementation(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(32 * 1024 * 1024) }) as Response);
    async function open(id: string) {
        const hook = renderHook(() => useFetchDocxBytes(id, "v1"));
        await waitFor(() => expect(hook.result.current.bytes).not.toBeNull());
        hook.unmount();
    }
    for (const id of ["A", "B", "A", "C", "A", "B"]) await open(id);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/file/A", "/file/B", "/file/C", "/file/B"]);
});

it("invalidates a source URL preview and its in-flight request after a save", async () => {
    const fetch = vi.mocked(authenticatedFetch);
    fetch.mockClear();
    let finishOld!: (response: Response) => void;
    fetch.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
        .mockResolvedValueOnce(new Response(new Uint8Array([2])));
    const old = renderHook(() => useFetchDocxBytes("source-doc", "v1", undefined, "/source"));
    invalidateDocxBytes("source-doc", "v1");
    const current = renderHook(() => useFetchDocxBytes("source-doc", "v1", undefined, "/source"));
    await waitFor(() => expect(current.result.current.bytes).not.toBeNull());
    await act(async () => finishOld(new Response(new Uint8Array([1]))));
    old.unmount();
    current.unmount();
    const reopened = renderHook(() => useFetchDocxBytes("source-doc", "v1", undefined, "/source"));
    expect(new Uint8Array(reopened.result.current.bytes!)).toEqual(new Uint8Array([2]));
    expect(fetch).toHaveBeenCalledTimes(2);
});
