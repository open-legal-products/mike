"use client";

import { useEffect, useRef } from "react";

const CHECK_INTERVAL_MS = 60_000;
const MIN_CHECK_GAP_MS = 30_000;

/** Check metadata, never file bytes, while documents are open and the page is visible. */
export function useProjectDocumentRefresh(
    refresh: () => Promise<void>,
    activeTabId: string | null,
) {
    const lastCheckRef = useRef<number | null>(null);
    const pendingRef = useRef<Promise<void> | null>(null);
    useEffect(() => {
        // Initial project loading already fetched metadata; start the throttle on mount.
        if (lastCheckRef.current === null) lastCheckRef.current = Date.now();
        if (!activeTabId) return;
        const check = () => {
            if (
                document.visibilityState === "hidden" ||
                pendingRef.current ||
                Date.now() - (lastCheckRef.current ?? 0) < MIN_CHECK_GAP_MS
            )
                return;
            lastCheckRef.current = Date.now();
            const pending = refresh()
                // Deliberately silent: nobody asked for this check, no user
                // action fails when it does, and the next focus, visibility
                // change or interval tick retries it. Anything the user does
                // start (open, download, delete) reports its own failure.
                .catch(() => {})
                .finally(() => {
                    if (pendingRef.current === pending)
                        pendingRef.current = null;
                });
            pendingRef.current = pending;
        };
        check();
        window.addEventListener("focus", check);
        document.addEventListener("visibilitychange", check);
        const timer = window.setInterval(check, CHECK_INTERVAL_MS);
        return () => {
            window.removeEventListener("focus", check);
            document.removeEventListener("visibilitychange", check);
            window.clearInterval(timer);
        };
    }, [activeTabId, refresh]);
}
