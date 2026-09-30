import { StrictMode, createElement, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { getDocument } from "@/app/lib/mikeApi";
import type { Document } from "@/app/components/shared/types";
import { useDocumentPermissions } from "./useDocumentPermissions";
vi.mock("@/app/lib/mikeApi", () => ({ getDocument: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
it("fails closed while loading and uses document rights independently", async () => {
    vi.mocked(getDocument).mockImplementation(async (id) => ({ can_edit: id === "editable", can_delete: false }) as Document);
    const { result, rerender } = renderHook(({ enabled }) => useDocumentPermissions(["editable", "reader"], enabled), { initialProps: { enabled: true } });
    expect(result.current("editable").canEdit).toBe(false);
    await waitFor(() => expect(result.current("editable").canEdit).toBe(true));
    expect(result.current("reader")).toEqual({ canEdit: false, canDelete: false });
    expect(result.current("editable").canDelete).toBe(false);
    rerender({ enabled: false });
    expect(result.current("editable").canEdit).toBe(false);
});
it("does not enable editing for missing permissions or failed requests", async () => {
    vi.mocked(getDocument).mockResolvedValueOnce({} as Document).mockRejectedValueOnce(new Error("network"));
    const { result } = renderHook(() => useDocumentPermissions(["a", "b"], true));
    await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(2));
    expect(result.current("a").canEdit).toBe(false);
    expect(result.current("b").canDelete).toBe(false);
});

it("retains resolved rights and pending requests as tabs open and close", async () => {
    let finishSecond!: (document: Document) => void;
    vi.mocked(getDocument).mockImplementation((id) => id === "first"
        ? Promise.resolve({ can_edit: true, can_delete: true } as Document)
        : new Promise(resolve => { finishSecond = resolve; }));
    const { result, rerender } = renderHook(({ ids }) => useDocumentPermissions(ids, true), {
        initialProps: { ids: ["first"] },
    });
    await waitFor(() => expect(result.current("first").canEdit).toBe(true));
    rerender({ ids: ["first", "second"] });
    expect(result.current("first").canEdit).toBe(true);
    expect(result.current("second").canEdit).toBe(false);
    await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(2));
    rerender({ ids: ["second"] });
    rerender({ ids: ["second", "first", "first"] });
    await act(async () => finishSecond({ can_edit: true, can_delete: false } as Document));
    expect(result.current("first").canEdit).toBe(true);
    expect(result.current("second")).toEqual({ canEdit: true, canDelete: false });
    expect(getDocument).toHaveBeenCalledTimes(2);
});

it("clears rights on disable and ignores responses from the previous access session", async () => {
    let finishStale!: (document: Document) => void;
    vi.mocked(getDocument).mockResolvedValueOnce({ can_edit: true } as Document)
        .mockImplementationOnce(() => new Promise(resolve => { finishStale = resolve; }))
        .mockResolvedValue({ can_edit: false, can_delete: false } as Document);
    const { result, rerender } = renderHook(({ ids, enabled }) => useDocumentPermissions(ids, enabled), {
        initialProps: { ids: ["first"], enabled: true },
    });
    await waitFor(() => expect(result.current("first").canEdit).toBe(true));
    rerender({ ids: ["first", "second"], enabled: true });
    await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(2));
    rerender({ ids: ["first", "second"], enabled: false });
    expect(result.current("first").canEdit).toBe(false);
    rerender({ ids: ["first", "second"], enabled: true });
    expect(result.current("first").canEdit).toBe(false);
    await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(4));
    await act(async () => finishStale({ can_edit: true, can_delete: true } as Document));
    expect(result.current("second")).toEqual({ canEdit: false, canDelete: false });
});

it("resolves permissions after StrictMode remounts its effects", async () => {
    vi.mocked(getDocument).mockResolvedValue({ can_edit: true } as Document);
    const { result } = renderHook(() => useDocumentPermissions(["first"], true), {
        wrapper: ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children),
    });
    await waitFor(() => expect(result.current("first").canEdit).toBe(true));
});
