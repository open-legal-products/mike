import type { TabularReviewHistoryStatus } from "@mike/contracts";

type Activity = Pick<TabularReviewHistoryStatus, "id" | "updated_at" | "is_running" | "title" | "project_id" | "org_id"> &
    Partial<Pick<TabularReviewHistoryStatus, "is_complete">>;
type Listener = (statuses?: Activity[]) => void;
const listeners = new Set<Listener>();

/** Refresh workspace lists after a review is created, edited, or deleted. */
export function notifyTabularReviewsChanged(statuses?: Activity[]) {
    for (const listener of listeners) listener(statuses);
}

export function subscribeTabularReviewChanges(listener: Listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
