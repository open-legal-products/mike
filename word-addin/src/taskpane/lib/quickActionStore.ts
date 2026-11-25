import { useEffect, useSyncExternalStore } from "react";
import { listQuickActions } from "../api/mikeApi";
import type { QuickAction } from "../types";
import { useAddinWorkspace } from "./addinWorkspace";
import { notifyError } from "./notify";

let snapshot: QuickAction[] = [];
let loadPromise: Promise<void> | null = null;
let loaded = false;
// The workspace the snapshot (or the load in flight) is for. Quick actions
// are per workspace, so another workspace's are dropped, never shown.
let storeWorkspace: string | null = null;
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

function loadQuickActions(workspace: string): Promise<void> {
  if (storeWorkspace !== workspace) {
    storeWorkspace = workspace;
    snapshot = [];
    loaded = false;
    loadPromise = null;
    emitChange();
  }
  if (loaded) return Promise.resolve();
  if (loadPromise) return loadPromise;

  const isCurrent = (): boolean => storeWorkspace === workspace;
  const request: Promise<void> = listQuickActions(workspace)
    .then((actions) => {
      if (!isCurrent()) return;
      snapshot = actions;
      loaded = true;
      emitChange();
    })
    .catch((error: unknown) => {
      if (!isCurrent()) return;
      // An empty list here is indistinguishable from "you have no quick
      // actions", so the failure is named rather than mimed.
      snapshot = [];
      emitChange();
      notifyError(error, {
        action: "load your quick actions",
        dedupeKey: "quick-action-store",
        operation: "quick_actions.run",
        onRetry: () => {
          if (!isCurrent()) return;
          loaded = false;
          void loadQuickActions(workspace);
        },
      });
    })
    .finally(() => {
      if (loadPromise === request) loadPromise = null;
    });
  loadPromise = request;

  return request;
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

/** The quick actions of the pane's workspace. */
export function useQuickActions(): QuickAction[] {
  const { workspaceId } = useAddinWorkspace();
  const actions = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    void loadQuickActions(workspaceId);
  }, [workspaceId]);

  // Until the effect has started this workspace's load, the snapshot may
  // still be another workspace's.
  return storeWorkspace === workspaceId ? actions : NO_ACTIONS;
}

const NO_ACTIONS: QuickAction[] = [];
