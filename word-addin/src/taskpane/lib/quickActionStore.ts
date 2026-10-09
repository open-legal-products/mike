import { useEffect, useSyncExternalStore } from "react";
import { listQuickActions } from "../api/mikeApi";
import type { QuickAction } from "../types";
import { notifyError } from "./notify";

let snapshot: QuickAction[] = [];
let loadPromise: Promise<void> | null = null;
let loaded = false;
const listeners = new Set<() => void>();

function emitChange(): void {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): QuickAction[] {
  return snapshot;
}

function loadQuickActions(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = listQuickActions()
    .then((actions) => {
      snapshot = actions;
      loaded = true;
      emitChange();
    })
    .catch((error: unknown) => {
      // An empty list here is indistinguishable from "you have no quick
      // actions", so the failure is named rather than mimed.
      snapshot = [];
      emitChange();
      notifyError(error, {
        action: "load your quick actions",
        dedupeKey: "quick-action-store",
        onRetry: () => {
          loaded = false;
          void loadQuickActions();
        },
      });
    })
    .finally(() => {
      loadPromise = null;
    });

  return loadPromise;
}

export function replaceQuickAction(action: QuickAction): void {
  snapshot = snapshot.map((item) =>
    item.id === action.id ? action : item,
  );
  emitChange();
}

export function addQuickAction(action: QuickAction): void {
  snapshot = [...snapshot, action];
  emitChange();
}

export function useQuickActions(): QuickAction[] {
  const actions = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    void loadQuickActions();
  }, []);

  return actions;
}
