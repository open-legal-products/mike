import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Keep `ref.current` equal to the value from the latest render.
 *
 * A notice's "Retry" runs long after the render that raised it, and the
 * loader or mutation it should re-run has usually been re-created since
 * (its state, the page, or the user changed). Reading the action through a
 * ref at click time re-runs the current closure instead of the stale one the
 * failure captured.
 *
 * Use this form when the ref must exist before the value does — a callback
 * that retries itself — so the ref is declared above the callbacks and
 * filled below them:
 *
 *     const retryRef = useRef<(() => void) | null>(null);
 *     const load = useCallback(async () => {
 *         try { ... } catch (error) {
 *             notifyError(error, { onRetry: () => retryRef.current?.() });
 *         }
 *     }, []);
 *     useAssignLatest(retryRef, () => void load());
 *
 * The write happens in a layout effect, so the ref is current before any
 * event handler of the committed render can fire.
 */
export function useAssignLatest<T>(ref: { current: T }, value: T): void {
    useLayoutEffect(() => {
        ref.current = value;
    });
}

/** A ref that always holds the value from the latest render. */
export function useLatestRef<T>(value: T): RefObject<T> {
    const ref = useRef(value);
    useAssignLatest(ref, value);
    return ref;
}
