import { useEffect, useState } from "react";

/** The content area's left edge, from the window's left edge. */
export const CONTENT_AREA_LEFT_VAR = "--app-content-left";
/** The content area's right edge, from the window's right edge. */
export const CONTENT_AREA_RIGHT_VAR = "--app-content-right";

/**
 * Publishes where the app's content area (the page beside the sidebar) sits
 * in the window, as two CSS variables on the root element, so overlays that
 * are fixed to the window can centre on the page rather than on the whole
 * window (`content-area-inset-x` in ThemeTokensUI.css).
 *
 * It is measured, not worked out from the sidebar's state: the sidebar
 * animates open and closed, and below md it floats over the page instead of
 * pushing it. Returns the ref for the content area's element; the variables
 * are removed when it goes, so anything outside the app shell centres on the
 * window again.
 */
export function useContentAreaInsets() {
    const [node, setNode] = useState<HTMLElement | null>(null);

    useEffect(() => {
        if (!node) return;
        const root = document.documentElement;
        const measure = () => {
            const rect = node.getBoundingClientRect();
            root.style.setProperty(
                CONTENT_AREA_LEFT_VAR,
                `${Math.max(0, Math.round(rect.left))}px`,
            );
            root.style.setProperty(
                CONTENT_AREA_RIGHT_VAR,
                `${Math.max(0, Math.round(root.clientWidth - rect.right))}px`,
            );
        };
        measure();
        window.addEventListener("resize", measure);
        const observer =
            typeof ResizeObserver === "undefined"
                ? null
                : new ResizeObserver(measure);
        observer?.observe(node);
        return () => {
            window.removeEventListener("resize", measure);
            observer?.disconnect();
            root.style.removeProperty(CONTENT_AREA_LEFT_VAR);
            root.style.removeProperty(CONTENT_AREA_RIGHT_VAR);
        };
    }, [node]);

    return setNode;
}
