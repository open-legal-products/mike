import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { listQuickActions } from "../api/mikeApi";
import type { QuickAction } from "../types";
import { notifyError } from "./notify";

/** Each mounted account/workspace pane owns its own store, including writes. */
function createQuickActionStore(workspaceId: string) {
  let snapshot: QuickAction[] = [];
  let pending: Promise<void> | null = null;
  let loaded = false;
  const savedDuringLoad = new Map<string, QuickAction>();
  const listeners = new Set<() => void>();

  function publish(actions: QuickAction[]) {
    snapshot = actions;
    for (const listener of listeners) listener();
  }

  function load(): Promise<void> {
    if (loaded) return Promise.resolve();
    if (pending) return pending;

    pending = listQuickActions(workspaceId)
      .then((actions) => {
        const byId = new Map(actions.map((action) => [action.id, action]));
        for (const [id, action] of savedDuringLoad) byId.set(id, action);
        savedDuringLoad.clear();
        loaded = true;
        publish([...byId.values()]);
      })
      .catch((error: unknown) => {
        if (listeners.size === 0) return;
        notifyError(error, {
          action: "load your quick actions",
          dedupeKey: "quick-action-store",
          operation: "quick_actions.run",
          onRetry: () => {
            if (listeners.size > 0) void load();
          },
        });
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  return {
    load,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    save(action: QuickAction) {
      if (!loaded) savedDuringLoad.set(action.id, action);
      publish(snapshot.some((row) => row.id === action.id)
        ? snapshot.map((row) => row.id === action.id ? action : row)
        : [...snapshot, action]);
    },
  };
}

const QuickActionsContext = createContext<ReturnType<typeof createQuickActionStore> | null>(null);

export function QuickActionsProvider({
  workspaceId,
  children,
}: { workspaceId: string; children: ReactNode }) {
  const [store] = useState(() => createQuickActionStore(workspaceId));
  return <QuickActionsContext.Provider value={store}>{children}</QuickActionsContext.Provider>;
}

export function useQuickActionStore() {
  const store = useContext(QuickActionsContext);
  if (!store) throw new Error("Quick actions require a workspace pane.");
  return store;
}

export function useQuickActions(): QuickAction[] {
  const store = useQuickActionStore();
  const actions = useSyncExternalStore(store.subscribe, store.getSnapshot);

  useEffect(() => {
    void store.load();
  }, [store]);

  return actions;
}
