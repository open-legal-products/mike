"use client";

import {
    createContext,
    useContext,
    type ComponentProps,
    type ReactElement,
} from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import {
    LIQUID_GLASS_FLAT_CLASS,
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_SELECTED_CLASS,
    LIQUID_GLASS_SUBTLE_CLASS,
} from "./LiquidGlassUI";

export type TabPillSurface = "subtle" | "flat" | "plain";

/**
 * The surface for every tab pill inside it that does not name its own: a
 * table toolbar makes its pills, and those its actions render, plain.
 */
export const TabPillSurfaceContext = createContext<TabPillSurface | undefined>(
    undefined,
);

export type TabPillButtonUIProps = ComponentProps<"button"> & {
    active?: boolean;
    /**
     * "flat" suits tabs inside a flat panel; the active tab shows by its
     * text. "plain" has no glass at all: text only, with the grey hover fill,
     * and the grey selected fill on the active tab.
     */
    surface?: TabPillSurface;
};

const SURFACE_CLASS: Record<TabPillSurface, string> = {
    subtle: LIQUID_GLASS_SUBTLE_CLASS,
    flat: LIQUID_GLASS_FLAT_CLASS,
    plain: "",
};

const ACTIVE_CLASS: Record<TabPillSurface, string> = {
    subtle: "border-white/80 bg-white text-gray-900",
    flat: "text-gray-900",
    plain: `${LIQUID_GLASS_SELECTED_CLASS} text-gray-900`,
};

/** Canonical tab-style pill shared by the web app and Word add-in. */
export function TabPillButtonUI({
    active,
    surface: surfaceProp,
    type = "button",
    className,
    ...props
}: TabPillButtonUIProps): ReactElement {
    const surfaceFromContext = useContext(TabPillSurfaceContext);
    const surface = surfaceProp ?? surfaceFromContext ?? "subtle";
    const stateClass =
        active === true
            ? ACTIVE_CLASS[surface]
            : `${LIQUID_GLASS_HOVER_CLASS} text-gray-500 hover:text-gray-900`;

    return (
        <button
            data-slot="tab-pill-button"
            data-surface={surface}
            type={type}
            aria-pressed={active}
            className={twMerge(
                clsx(
                    `inline-flex h-7 items-center justify-center gap-1.5 rounded-full px-3 text-xs font-medium ${SURFACE_CLASS[surface]} transition-all active:scale-[0.98] focus-visible:outline-solid focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-40 disabled:active:scale-100`,
                    stateClass,
                    className,
                ),
            )}
            {...props}
        />
    );
}
