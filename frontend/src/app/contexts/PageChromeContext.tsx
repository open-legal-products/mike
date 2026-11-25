"use client";

import { createContext, useContext } from "react";

interface PageChromeContextValue {
    /** The small-screen top bar's right end, where a page's actions go. */
    mobileActionsContainer: HTMLElement | null;
    /** The top bar's slot beside the sidebar toggle, for a page's way back. */
    mobileBackContainer: HTMLElement | null;
}

export const PageChromeContext = createContext<PageChromeContextValue>({
    mobileActionsContainer: null,
    mobileBackContainer: null,
});

export function usePageChrome() {
    return useContext(PageChromeContext);
}
