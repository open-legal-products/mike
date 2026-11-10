import { useSyncExternalStore } from "react";

type Listener = () => void;
const changeListeners = new Set<Listener>();

/** Refresh lists of runs after one starts or finishes. */
export function notifyPlaybookRunsChanged() {
    for (const listener of changeListeners) listener();
}

export function subscribePlaybookRunChanges(listener: Listener) {
    changeListeners.add(listener);
    return () => {
        changeListeners.delete(listener);
    };
}

// The run whose results are on screen, so History neither marks it as newly
// finished nor leaves it unselected.
let viewedRunId: string | null = null;
const viewListeners = new Set<Listener>();

export function setViewedPlaybookRun(id: string | null) {
    if (viewedRunId === id) return;
    viewedRunId = id;
    for (const listener of viewListeners) listener();
}

function subscribeViewedRun(listener: Listener) {
    viewListeners.add(listener);
    return () => {
        viewListeners.delete(listener);
    };
}

export function useViewedPlaybookRun() {
    return useSyncExternalStore(
        subscribeViewedRun,
        () => viewedRunId,
        () => null,
    );
}

/** Opens a run on its playbook's Runs tab. */
export function playbookRunPath(run: { id: string; playbookId: string }) {
    return `/playbooks/${encodeURIComponent(run.playbookId)}?tab=runs&run=${encodeURIComponent(run.id)}`;
}
