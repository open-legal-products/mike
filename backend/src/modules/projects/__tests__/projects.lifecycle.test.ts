import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";
const { capture, complete } = vi.hoisted(() => ({ capture: vi.fn(), complete: vi.fn() }));
vi.mock("../../documents/documents.service", () => ({
    captureInlineDocumentCleanup: capture,
    completeInlineDocumentCleanup: complete,
}));
import { deleteProjectsByIds } from "../projects.lifecycle";
describe("project deletion lifecycle", () => {
    beforeEach(() => { vi.resetAllMocks(); capture.mockResolvedValue(["object-key"]); complete.mockResolvedValue(undefined); });
    function database(failAt?: number) {
        const trace: string[] = [];
        const batches: string[][] = [];
        const db = { from(table: string) {
                expect(table).toBe("projects");
                return { delete: () => ({ in: async (column: string, ids: string[]) => {
                            expect(column).toBe("id");
                            batches.push(ids);
                            trace.push("delete");
                            return { error: batches.length === failAt ? { message: "database unavailable" } : null };
                        } }) };
            } } as unknown as Db;
        capture.mockImplementation(async () => { trace.push("capture"); return ["object-key"]; });
        complete.mockImplementation(async () => { trace.push("complete"); });
        return { db, trace, batches };
    }
    it("captures cleanup before batching unique IDs and completes it only after all deletes", async () => {
        const { db, trace, batches } = database();
        const ids = Array.from({ length: 501 }, (_, i) => `p${i}`);
        expect(await deleteProjectsByIds(db, [...ids, "p0", ""])).toBe(501);
        expect(batches.map(b => b.length)).toEqual([500, 1]);
        expect(batches.flat()).toEqual(ids);
        expect(capture).toHaveBeenCalledWith(db, { projectIds: ids });
        expect(complete).toHaveBeenCalledWith(db, ["object-key"]);
        expect(trace).toEqual(["capture", "delete", "delete", "complete"]);
    });
    it("leaves a failed batch retryable without completing cleanup", async () => {
        const { db, trace } = database(2);
        await expect(deleteProjectsByIds(db, Array.from({ length: 501 }, (_, i) => `p${i}`))).rejects.toThrow("Failed to delete projects");
        expect(trace).toEqual(["capture", "delete", "delete"]);
    });
    it("does no deletion if cleanup capture fails", async () => {
        const { db, batches } = database();
        capture.mockRejectedValue(new Error("capture failed"));
        await expect(deleteProjectsByIds(db, ["p1"])).rejects.toThrow("capture failed");
        expect(batches).toEqual([]);
        expect(complete).not.toHaveBeenCalled();
    });
    it("propagates cleanup completion failure so callers retry", async () => {
        const { db } = database();
        complete.mockRejectedValue(new Error("storage unavailable"));
        await expect(deleteProjectsByIds(db, ["p1"])).rejects.toThrow("storage unavailable");
    });
    it("does no work for empty IDs", async () => {
        const { db, trace } = database();
        expect(await deleteProjectsByIds(db, [])).toBe(0);
        expect(trace).toEqual([]);
    });
});
