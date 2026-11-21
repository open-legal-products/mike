/**
 * Collects events that arrive from separate async callbacks (which React
 * does not batch) and hands them to `apply` once per animation frame, so a
 * burst of N events costs one state update instead of N. `flush` applies
 * whatever is pending immediately; call it when the producer finishes so the
 * last events are never left waiting on a frame.
 */
export function createFrameBatcher<T>(apply: (batch: T[]) => void) {
    let pending: T[] = [];
    let frame: number | null = null;

    function flush() {
        if (frame !== null) {
            cancelAnimationFrame(frame);
            frame = null;
        }
        if (pending.length === 0) return;
        const batch = pending;
        pending = [];
        apply(batch);
    }

    return {
        push(event: T) {
            pending.push(event);
            if (frame === null) {
                frame = requestAnimationFrame(() => {
                    frame = null;
                    flush();
                });
            }
        },
        flush,
    };
}
