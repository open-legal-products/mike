import { useState, useSyncExternalStore } from "react";
import type { TabularCell } from "../shared/types";
import { indexReviewCells } from "./reviewCellIndex";

type Change = TabularCell[] | ((previous: TabularCell[]) => TabularCell[]);
const key = (row: string, column: number) => `${row}:${column}`;

/** Structural changes publish a list; stream patches publish only one cell. */
export class ReviewCellStore {
    private structure: TabularCell[] = [];
    private rows = indexReviewCells([]);
    private listeners = new Set<() => void>();
    private cellListeners = new Map<string, Set<() => void>>();
    getStructure = () => this.structure;
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };
    get = (row: string, column: number) => this.rows.get(row)?.get(column);
    values = () => this.structure.map(cell => this.get(cell.row_id, cell.column_index) ?? cell);
    set = (change: Change) => {
        const next = typeof change === "function" ? change(this.values()) : change;
        this.structure = next;
        this.rows = indexReviewCells(next);
        this.listeners.forEach(listener => listener());
        this.cellListeners.forEach(listeners => listeners.forEach(listener => listener()));
    };
    patch(row: string, column: number, patch: Partial<TabularCell>) {
        const previous = this.get(row, column);
        if (!previous) return;
        this.rows.get(row)!.set(column, { ...previous, ...patch });
        this.cellListeners.get(key(row, column))?.forEach(listener => listener());
    }
    subscribeCell(row: string, column: number, listener: () => void) {
        const identity = key(row, column);
        let listeners = this.cellListeners.get(identity);
        if (!listeners) this.cellListeners.set(identity, listeners = new Set());
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
            if (!listeners.size) this.cellListeners.delete(identity);
        };
    }
}

export function useReviewCells() {
    const [store] = useState(() => new ReviewCellStore());
    const cells = useSyncExternalStore(store.subscribe, store.getStructure, store.getStructure);
    return [cells, store.set, store] as const;
}
