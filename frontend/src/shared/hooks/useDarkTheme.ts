import { useSyncExternalStore } from "react";

// Inline SVG and sandboxed frames cannot be reached by the class-based dark
// remapping in globals.css, so they watch the document theme class
// themselves. One observer serves every subscriber on the page. Targets that
// never set the class (the Word add-in) always read false.
const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | null = null;

function subscribeToTheme(listener: () => void): () => void {
    themeListeners.add(listener);
    if (!themeObserver && typeof MutationObserver !== "undefined") {
        themeObserver = new MutationObserver(() => {
            themeListeners.forEach((notify) => notify());
        });
        themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["class"],
        });
    }

    return () => {
        themeListeners.delete(listener);
        if (themeListeners.size === 0) {
            themeObserver?.disconnect();
            themeObserver = null;
        }
    };
}

function readDarkTheme(): boolean {
    return (
        typeof document !== "undefined" &&
        document.documentElement.classList.contains("dark")
    );
}

function readDarkThemeOnServer(): boolean {
    return false;
}

export function useDarkTheme(): boolean {
    return useSyncExternalStore(
        subscribeToTheme,
        readDarkTheme,
        readDarkThemeOnServer,
    );
}
