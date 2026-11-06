"use client";

import { type ButtonHTMLAttributes, type ReactElement } from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import {
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_SUBTLE_CLASS,
} from "./LiquidGlassUI";

export type GlassIconButtonUIProps = Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "className"
> & {
    className?: string;
    /** Required: the button is icon-only, so it has no text to name it. */
    "aria-label": string;
};

const BASE_CLASS =
    `flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-gray-500 ${LIQUID_GLASS_SUBTLE_CLASS} ${LIQUID_GLASS_HOVER_CLASS} transition-colors hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2`;

export function glassIconButtonUIClassName(className?: string) {
    return twMerge(clsx(BASE_CLASS, className));
}

/** Canonical circular glass icon button (modal close, panel dismiss, …). */
export function GlassIconButtonUI({
    type = "button",
    className,
    ...props
}: GlassIconButtonUIProps): ReactElement {
    return (
        <button
            type={type}
            className={glassIconButtonUIClassName(className)}
            {...props}
        />
    );
}
