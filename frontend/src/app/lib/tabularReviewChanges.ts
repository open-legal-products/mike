type Listener = () => void;
const listeners = new Set<Listener>();

/** Refresh workspace lists after a review is created, edited, or deleted. */
export function notifyTabularReviewsChanged() {
    for (const listener of listeners) listener();
}

export function subscribeTabularReviewChanges(listener: Listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
