import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/app/lib/authEvents";
import { useFetchSingleDoc } from "./useFetchSingleDoc";

vi.mock("@/app/lib/authEvents", () => ({ authenticatedFetch: vi.fn() }));
beforeEach(() => vi.mocked(authenticatedFetch).mockReset());
const pdf = () =>
    new Response(new Uint8Array([1, 2]), {
        headers: { "Content-Type": "application/pdf" },
    });

it("does not refetch stable inputs, refreshes revisions, and clears a closed document", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(async () => pdf());
    const { result, rerender } = renderHook(
        ({ id, revision }) => useFetchSingleDoc(id, "v1", null, revision),
        { initialProps: { id: "d1" as string | null, revision: "r1" } },
    );
    await waitFor(() => expect(result.current.result?.type).toBe("pdf"));
    const loaded = result.current.result;
    rerender({ id: "d1", revision: "r1" });
    expect(result.current.result).toBe(loaded);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    rerender({ id: "d1", revision: "r2" });
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ id: null, revision: "r2" });
    expect(result.current.result).toBeNull();
    expect(result.current.error).toBeNull();
});

it("aborts superseded downloads and ignores late results", async () => {
    let finish!: (response: Response) => void;
    vi.mocked(authenticatedFetch)
        .mockReturnValueOnce(
            new Promise((resolve) => {
                finish = resolve;
            }),
        )
        .mockImplementation(async () => pdf());
    const { result, rerender, unmount } = renderHook(
        ({ version }) => useFetchSingleDoc("d1", version),
        { initialProps: { version: "v1" } },
    );
    const oldSignal = vi.mocked(authenticatedFetch).mock.calls[0][1]?.signal;
    rerender({ version: "v2" });
    expect(oldSignal?.aborted).toBe(true);
    await waitFor(() => expect(result.current.result?.type).toBe("pdf"));
    const latest = result.current.result;
    await act(async () =>
        finish(
            new Response("old spreadsheet", {
                headers: { "Content-Type": "application/vnd.ms-excel" },
            }),
        ),
    );
    expect(result.current.result).toBe(latest);
    const latestSignal = vi.mocked(authenticatedFetch).mock.calls[1][1]?.signal;
    unmount();
    expect(latestSignal?.aborted).toBe(true);
});
