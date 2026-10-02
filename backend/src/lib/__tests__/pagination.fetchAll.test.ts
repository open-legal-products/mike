import { describe, expect, it, vi } from "vitest";
import { fetchAllPages } from "../pagination";

describe("fetchAllPages", () => {
    it("reads ranges until a short page", async () => {
        const page = vi
            .fn()
            .mockResolvedValueOnce({ data: [1, 2], error: null })
            .mockResolvedValueOnce({ data: [3], error: null });
        await expect(fetchAllPages(page, 2)).resolves.toEqual({
            ok: true,
            rows: [1, 2, 3],
        });
        expect(page.mock.calls).toEqual([
            [0, 1],
            [2, 3],
        ]);
    });

    it("stops at the first error", async () => {
        const error = new Error("db down");
        const page = vi.fn().mockResolvedValue({ data: null, error });
        await expect(fetchAllPages(page, 2)).resolves.toEqual({ ok: false, error });
        expect(page).toHaveBeenCalledTimes(1);
    });

    it("treats an empty first page as done", async () => {
        const page = vi.fn().mockResolvedValue({ data: [], error: null });
        await expect(fetchAllPages(page)).resolves.toEqual({ ok: true, rows: [] });
    });
});
