import { useEffect, useRef, useState } from "react";

/**
 * Hide jitter from arrival of streamed text chunks by revealing characters at
 * a smooth, rate-paced clip rather than rendering every chunk verbatim.
 *
 * Returns a prefix of `text` whose length grows over time toward the full
 * length. When `active` is false (stream ended, message replayed from
 * history, etc.), snaps to the full text immediately.
 *
 * Rate adapts to backlog: small backlogs reveal at a 40 cps floor; large
 * backlogs catch up within ~0.4s, so the smoothing never lags noticeably
 * behind the server.
 */
export function useSmoothedReveal(text: string, active: boolean): string {
    const [revealedInt, setRevealedInt] = useState(text.length);
    const animation = useRef({
        cursor: text.length,
        published: text.length,
        target: text.length,
        frame: null as number | null,
        lastTick: 0,
    });

    useEffect(() => {
        const state = animation.current;
        state.target = text.length;
        if (!active || state.cursor > state.target) {
            state.cursor = state.target;
            if (state.published !== state.target) {
                state.published = state.target;
                setRevealedInt(state.target);
            }
        }
        if (!active || state.cursor >= state.target) {
            if (state.frame !== null) cancelAnimationFrame(state.frame);
            state.frame = null;
            return;
        }
        // New chunks update the target without cancelling the pending frame
        // or resetting elapsed time. Otherwise a delta just before each frame
        // can indefinitely slow the reveal, especially on a busy renderer.
        if (state.frame !== null) return;
        state.lastTick = performance.now();
        const step = (now: number) => {
            state.frame = null;
            const dt = Math.max(0, (now - state.lastTick) / 1000);
            state.lastTick = now;
            const backlog = state.target - state.cursor;
            state.cursor = Math.min(
                state.target,
                state.cursor + Math.max(40, backlog / 0.4) * dt,
            );
            const next = Math.floor(state.cursor);
            if (next !== state.published) {
                state.published = next;
                setRevealedInt(next);
            }
            // Sleep while caught up. A later delta wakes the scheduler above.
            if (state.cursor < state.target) {
                state.frame = requestAnimationFrame(step);
            }
        };
        state.frame = requestAnimationFrame(step);
    }, [text.length, active]);

    useEffect(() => {
        const state = animation.current;
        return () => {
            if (state.frame !== null) cancelAnimationFrame(state.frame);
            state.frame = null;
        };
    }, []);

    // Once the stream ends, render the authoritative text immediately, before
    // the effect synchronizes the animation cursor.
    if (!active) return text;

    return text.slice(0, Math.min(revealedInt, text.length));
}
