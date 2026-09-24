import { webcrypto, createHash } from "node:crypto";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DOCX_AUTOSAVE_DELAY, useDocxAutosave } from "./useDocxAutosave";
import { listDocumentVersions, replaceDocumentVersionFile } from "@/app/lib/mikeApi";
import { UploadBatchError } from "@/shared/api/uploadSessionClient";
import { invalidateDocxBytes } from "./useFetchDocxBytes";

vi.mock("@/app/lib/mikeApi", () => ({
    listDocumentVersions: vi.fn(), replaceDocumentVersionFile: vi.fn(),
    MikeApiError: class extends Error {},
}));
vi.mock("./useFetchDocxBytes", () => ({ invalidateDocxBytes: vi.fn() }));
const original = new Uint8Array([1]).buffer;
const edited = new Uint8Array([2]).buffer;
const hash = (bytes: ArrayBuffer) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
const exportDocx = vi.fn<() => Promise<ArrayBuffer>>();
const options = () => ({ documentId: "doc", versionId: "v1", filename: "Agreement.docx", bytes: original, enabled: true, exportDocx });
beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("crypto", webcrypto);
    vi.clearAllMocks();
    exportDocx.mockResolvedValue(edited);
    vi.mocked(replaceDocumentVersionFile).mockResolvedValue({ id: "v1", version_number: 1, source: "user_upload", created_at: "", filename: "Agreement.docx" });
    vi.mocked(listDocumentVersions).mockResolvedValue({ current_version_id: "v1", versions: [] });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("debounces edits, saves the open version with a hash precondition, and evicts cached bytes", async () => {
    const { result } = renderHook(() => useDocxAutosave(options()));
    act(() => result.current.markChanged());
    await act(() => vi.advanceTimersByTimeAsync(1000));
    act(() => result.current.markChanged());
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(replaceDocumentVersionFile).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(DOCX_AUTOSAVE_DELAY); await result.current.save(); });
    expect(replaceDocumentVersionFile).toHaveBeenCalledExactlyOnceWith("doc", "v1", expect.objectContaining({ name: "Agreement.docx", size: 1 }), undefined, { expectedContentSha256: hash(original), generatePdf: false });
    expect(result.current).toMatchObject({ dirty: false, status: "saved", error: null });
    expect(invalidateDocxBytes).toHaveBeenCalledWith("doc");
});

it("serializes saves and persists edits made during an upload using the new base hash", async () => {
    let finish!: () => void;
    vi.mocked(replaceDocumentVersionFile).mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ id: "v1", version_number: 1, source: "user_upload", created_at: "", filename: "Agreement.docx" }); }));
    const { result } = renderHook(() => useDocxAutosave(options()));
    act(() => result.current.markChanged());
    let pending!: Promise<void>;
    await act(async () => { pending = result.current.save(); await vi.waitFor(() => expect(replaceDocumentVersionFile).toHaveBeenCalledOnce()); });
    exportDocx.mockResolvedValue(new Uint8Array([3]).buffer);
    act(() => result.current.markChanged());
    expect(result.current.dirty).toBe(true);
    expect(result.current.save()).toBe(pending);
    await act(async () => { finish(); await pending; });
    expect(replaceDocumentVersionFile).toHaveBeenCalledTimes(2);
    expect(vi.mocked(replaceDocumentVersionFile).mock.calls[1][4]).toEqual({ expectedContentSha256: hash(edited), generatePdf: false });
    expect(result.current.dirty).toBe(false);
});

it("retains dirty state on conflict and does not retry automatically", async () => {
    vi.mocked(replaceDocumentVersionFile).mockRejectedValueOnce(new UploadBatchError("internal details", [{ clientId: "a", filename: "a.docx", status: "error", result: null, errorCode: "document_changed" }]));
    const { result } = renderHook(() => useDocxAutosave(options()));
    act(() => result.current.markChanged());
    await act(() => result.current.save());
    expect(result.current.error).toMatch(/changed elsewhere/);
    expect(result.current.dirty).toBe(true);
    act(() => result.current.markChanged());
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(replaceDocumentVersionFile).toHaveBeenCalledOnce();
    await act(() => result.current.save());
    expect(result.current).toMatchObject({ dirty: false, status: "saved" });
});

it("keeps a failed save retryable and resolves an unpinned version before writing", async () => {
    vi.mocked(replaceDocumentVersionFile).mockRejectedValueOnce(new Error("private storage detail"));
    const { result } = renderHook(() => useDocxAutosave({ ...options(), versionId: null }));
    act(() => result.current.markChanged());
    await act(() => result.current.save());
    expect(result.current.error).toMatch(/could not be saved/);
    expect(result.current.error).not.toMatch(/private/);
    expect(result.current.dirty).toBe(true);
    await act(() => result.current.save());
    expect(listDocumentVersions).toHaveBeenCalledOnce();
    expect(result.current.dirty).toBe(false);
});

it("does not upload local previews or unchanged documents", async () => {
    const { result } = renderHook(() => useDocxAutosave({ ...options(), enabled: false }));
    await act(() => result.current.save());
    act(() => result.current.markChanged());
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    await act(() => result.current.save());
    expect(replaceDocumentVersionFile).not.toHaveBeenCalled();
});

it("flushes a pending edit when its viewer unmounts", async () => {
    const { result, unmount } = renderHook(() => useDocxAutosave(options()));
    act(() => result.current.markChanged());
    unmount();
    await vi.waitFor(() => expect(replaceDocumentVersionFile).toHaveBeenCalledOnce());
});
