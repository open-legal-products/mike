import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { downloadBlob } from "@/app/lib/downloadDocument";
import { getDocumentComparison } from "@/app/lib/mikeApi";
import { useDocumentComparison } from "./useDocumentComparison";

vi.mock("@/app/lib/downloadDocument", () => ({ downloadBlob: vi.fn() }));
vi.mock("@/app/lib/mikeApi", async (original) => ({ ...(await original()), getDocumentComparison: vi.fn() }));

it("cancels a pending tab download on close and ignores its late result after reopening", async () => {
    const version = { id: "v1", version_number: 1, source: "upload", created_at: "", filename: "Draft.docx" };
    const pair = { base: version, target: { ...version, id: "v2", version_number: 2 } };
    let finish!: (bytes: ArrayBuffer) => void;
    const freshBytes = new Uint8Array([2]).buffer;
    vi.mocked(getDocumentComparison)
        .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
        .mockResolvedValueOnce(freshBytes);
    const { result } = renderHook(() => useDocumentComparison("doc", "v2"));
    act(() => result.current.open(pair));
    const pendingDownload = result.current.comparison!.download();
    act(() => result.current.close());
    expect(vi.mocked(getDocumentComparison).mock.calls[0][3].aborted).toBe(true);

    act(() => result.current.open(pair));
    await waitFor(() => expect(result.current.comparison?.bytes).toBe(freshBytes));
    await act(async () => {
        finish(new Uint8Array([1]).buffer);
        await pendingDownload;
    });
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(result.current.comparison?.bytes).toBe(freshBytes);
});
