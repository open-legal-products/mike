import { renderHook, waitFor } from "@testing-library/react";
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
