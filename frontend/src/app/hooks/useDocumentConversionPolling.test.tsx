import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDocumentStatuses } from "../lib/mikeApi";
import { useDocumentConversionPolling } from "./useDocumentConversionPolling";
import type { Document } from "../components/shared/types";
vi.mock("../lib/mikeApi", () => ({ getDocumentStatuses: vi.fn() }));
const doc = (id: string, status = "processing") => ({id, status} as Document);
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
describe("conversion polling", () => {
    it("batches 250 ids, limits concurrency and prevents overlapping cycles", async () => {
        vi.useFakeTimers();
        const pending: (() => void)[] = [];
        vi.mocked(getDocumentStatuses).mockImplementation(ids => new Promise(resolve => pending.push(() => resolve(ids.map(id => doc(id,"ready"))))));
        const {result, unmount} = renderHook(() => {
            const [documents, setDocuments] = useState(Array.from({length:250}, (_,i) => doc(String(i))));
            useDocumentConversionPolling(documents, setDocuments);
            return documents;
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
        expect(getDocumentStatuses).toHaveBeenCalledTimes(2);
        expect(vi.mocked(getDocumentStatuses).mock.calls[0][0]).toHaveLength(100);
        await act(async () => { pending.shift()!(); await Promise.resolve(); });
        expect(getDocumentStatuses).toHaveBeenCalledTimes(3);
        expect(vi.mocked(getDocumentStatuses).mock.calls[2][0]).toHaveLength(50);
        await act(async () => { for (const finish of pending.splice(0)) finish(); });
        expect(result.current.every(d => d.status === "ready")).toBe(true);
        await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
        expect(getDocumentStatuses).toHaveBeenCalledTimes(3);
        unmount();
    });
    it("retries failures and ignores late responses after unmount", async () => {
        vi.useFakeTimers();
        let finish!: (value: Document[]) => void;
        vi.mocked(getDocumentStatuses).mockRejectedValueOnce(new Error("offline")).mockImplementationOnce(() => new Promise(resolve => {finish=resolve;}));
        const set = vi.fn();
        const {unmount} = renderHook(() => useDocumentConversionPolling([doc("a")], set));
        await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
        expect(getDocumentStatuses).toHaveBeenCalledTimes(2);
        set.mockClear();
        unmount();
        await act(async () => {finish([doc("a","ready")]);});
        expect(set).not.toHaveBeenCalled();
        expect(vi.mocked(getDocumentStatuses).mock.calls[1][1]?.aborted).toBe(true);
    });
});
