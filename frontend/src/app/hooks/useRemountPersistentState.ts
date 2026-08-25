"use client";

import {
    type Dispatch,
    type SetStateAction,
    useCallback,
    useMemo,
    useSyncExternalStore,
} from "react";

class StoreEntry<T> {
    private value: T;
    private readonly listeners = new Set<() => void>();

    constructor(initialValue: T) {
        this.value = initialValue;
    }

    getSnapshot = () => this.value;

    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    setValue = (update: SetStateAction<T>) => {
        const next =
            typeof update === "function"
                ? (update as (current: T) => T)(this.value)
                : update;
        if (Object.is(this.value, next)) return;
        this.value = next;
        this.listeners.forEach((listener) => listener());
    };
}

const entries = new Map<string, StoreEntry<unknown>>();

function entryFor<T>(key: string, initialValue: T): StoreEntry<T> {
    const existing = entries.get(key);
    if (existing) return existing as StoreEntry<T>;
    const created = new StoreEntry(initialValue);
    entries.set(key, created as StoreEntry<unknown>);
    return created;
}

/**
 * State for short-lived UI activity that must survive a component remount.
 * Callers should use a key scoped to the workspace and reset the value when
 * the activity finishes.
 */
export function useRemountPersistentState<T>(
    key: string,
    initialValue: T,
): [T, Dispatch<SetStateAction<T>>] {
    const entry = useMemo(
        () => entryFor(key, initialValue),
        [key, initialValue],
    );
    const value = useSyncExternalStore(
        entry.subscribe,
        entry.getSnapshot,
        entry.getSnapshot,
    );
    const setValue = useCallback<Dispatch<SetStateAction<T>>>(
        (update) => entry.setValue(update),
        [entry],
    );
    return [value, setValue];
}
