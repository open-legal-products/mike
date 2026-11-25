"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Below this width the sidebar is a drawer, closed until it is opened. */
export const SIDEBAR_DRAWER_BELOW = 768;
/**
 * From the drawer width up to this one the sidebar is collapsed to its icons,
 * leaving the page the room; at and above it the sidebar is as the person
 * last left it.
 */
export const SIDEBAR_RAIL_BELOW = 1024;

export type SidebarWidthTier = "drawer" | "rail" | "full";

export function sidebarWidthTier(width: number): SidebarWidthTier {
    if (width < SIDEBAR_DRAWER_BELOW) return "drawer";
    if (width < SIDEBAR_RAIL_BELOW) return "rail";
    return "full";
}

const STORAGE_KEY = "sidebarOpen";

function currentTier(): SidebarWidthTier {
    return typeof window === "undefined"
        ? "full"
        : sidebarWidthTier(window.innerWidth);
}

function readPreference(): boolean {
    if (typeof window === "undefined") return true;
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        return saved !== null ? saved === "true" : true;
    } catch {
        return true;
    }
}

/**
 * Whether the app sidebar is open, by the window's width. The person's own
 * choice (open or collapsed) is remembered for wide windows. Narrowing the
 * window past SIDEBAR_RAIL_BELOW collapses an open sidebar, and past
 * SIDEBAR_DRAWER_BELOW closes it; widening it again past SIDEBAR_RAIL_BELOW
 * restores the choice. Between the two it can still be opened by hand,
 * without changing the choice. Only crossing a width changes it, so a
 * sidebar opened by hand stays open while the window is resized within one.
 */
export function useResponsiveSidebar() {
    const [preferredOpen, setPreferredOpen] = useState(readPreference);
    const [isOpen, setIsOpen] = useState(() => currentTier() === "full");
    const tier = useRef<SidebarWidthTier>(currentTier());
    const preferred = useRef(preferredOpen);
    useEffect(() => {
        preferred.current = preferredOpen;
    }, [preferredOpen]);

    // Persist what is actually on screen. The mount initializer above reads
    // this key back but `isOpen` starts open on wide windows regardless, so
    // storing anything else leaves the restored preference disagreeing with
    // the rendered sidebar and the first toggle click is spent re-syncing
    // them. Remembering a collapsed sidebar across reloads needs the mount
    // path to apply the stored value too — a separate change.
    useEffect(() => {
        if (currentTier() !== "full") return;
        try {
            localStorage.setItem(STORAGE_KEY, isOpen.toString());
        } catch {
            // Storage refused (a private window): the choice lasts the visit.
        }
        // Only a change of the person's choice is stored.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [preferredOpen]);

    useEffect(() => {
        const handleResize = () => {
            const next = sidebarWidthTier(window.innerWidth);
            if (next === tier.current) return;
            tier.current = next;
            setIsOpen(next === "full" ? preferred.current : false);
        };
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, []);

    /** The sidebar's own button: on a wide window it is the person's choice. */
    const toggle = useCallback(() => {
        if (currentTier() === "full") {
            const next = !preferred.current;
            preferred.current = next;
            setPreferredOpen(next);
            setIsOpen(next);
        } else {
            setIsOpen((open) => !open);
        }
    }, []);

    /** A page asking for the room (or giving it back). */
    const setOpen = useCallback((open: boolean) => {
        const now = currentTier();
        if (now === "drawer") {
            if (!open) setIsOpen(false);
            return;
        }
        setIsOpen(open);
        if (now === "full") {
            preferred.current = open;
            setPreferredOpen(open);
        }
    }, []);

    return { isOpen, toggle, setOpen };
}
