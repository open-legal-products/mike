import { useSyncExternalStore } from "react";

/** Tailwind's `md` breakpoint, where the sidebar sits beside the page. */
const DESKTOP_QUERY = "(min-width: 768px)";

function subscribe(onChange: () => void) {
    if (typeof window === "undefined" || !window.matchMedia) return () => {};
    const query = window.matchMedia(DESKTOP_QUERY);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
}

function getSnapshot() {
    // Without matchMedia (some test environments) the wide layout is assumed.
    if (typeof window === "undefined" || !window.matchMedia) return true;
    return window.matchMedia(DESKTOP_QUERY).matches;
}

function getServerSnapshot() {
    return true;
}

/** Whether the window is at least `md` wide, kept current as it resizes. */
export function useIsDesktop() {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
