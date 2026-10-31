import { act, render, screen } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vitest";
import { ReviewCellStore } from "./reviewCellStore";
import type { TabularCell } from "../shared/types";
const cell = (i: number) => ({ id: String(i), row_id: String(i), column_index: 0, content: null, status: "pending" } as TabularCell);

describe("review cell subscriptions", () => {
    it.each([100, 200, 400])("updates %i cells without republishing or reading the full grid", n => {
        const store = new ReviewCellStore();
        store.set(Array.from({ length: n }, (_, i) => cell(i)));
        const structural = vi.fn();
        store.subscribe(structural);
        const unrelated = vi.fn();
        const unsubscribe = store.subscribeCell("0", 1, unrelated);
        const values = vi.spyOn(store, "values");
        for (let i = 0; i < n; i++) store.patch(String(i), 0, { status: "done" });
        expect(structural).not.toHaveBeenCalled();
        expect(values).not.toHaveBeenCalled();
        expect(unrelated).not.toHaveBeenCalled();
        unsubscribe();
        expect(store.get(String(n-1), 0)?.status).toBe("done");
    });
    it("notifies the affected mounted cell and preserves stream results during structural edits", () => {
        const store = new ReviewCellStore();
        store.set([cell(0), cell(1)]);
        const renders = vi.fn();
        function Cell({ index }: { index: number }) {
            renders(index);
            const current = useSyncExternalStore(listener => store.subscribeCell(String(index), 0, listener), () => store.get(String(index), 0));
            return <span data-testid={`cell-${index}`}>{current?.content?.summary}</span>;
        }
        render(<><Cell index={0} /><Cell index={1} /></>);
        act(() => store.patch("1", 0, { content: { summary: "Fresh" } }));
        expect(screen.getByTestId("cell-1")).toHaveTextContent("Fresh");
        expect(renders.mock.calls.map(([index]) => index)).toEqual([0, 1, 1]);
        act(() => store.set(previous => previous.filter(item => item.row_id !== "0")));
        expect(store.values()[0].content?.summary).toBe("Fresh");
        store.patch("missing", 0, { status: "done" });
        expect(store.values()).toHaveLength(1);
    });
});
