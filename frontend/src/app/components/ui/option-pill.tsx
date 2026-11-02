"use client";

import type { ButtonHTMLAttributes, ReactElement } from "react";
import { cn } from "@/app/lib/utils";
import {
    LIQUID_GLASS_FLAT_CLASS,
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_SUBTLE_CLASS,
} from "@/shared/ui/LiquidGlassUI";

export type OptionPillProps = ButtonHTMLAttributes<HTMLButtonElement> & {
    surface?: "subtle" | "flat";
};

/** A compact removable option, distinct from an action button. */
export function OptionPill({
    type = "button",
    className,
    surface = "subtle",
    ...props
}: OptionPillProps): ReactElement {
    return (
        <button
            type={type}
            data-slot="option-pill"
            className={cn(
                `inline-flex max-w-full items-center justify-center gap-1.5 rounded-full px-2 py-1 text-xs font-normal text-gray-700 ${LIQUID_GLASS_HOVER_CLASS} transition-colors disabled:cursor-not-allowed disabled:opacity-40`,
                surface === "flat" ? LIQUID_GLASS_FLAT_CLASS : LIQUID_GLASS_SUBTLE_CLASS,
                className,
            )}
            {...props}
        />
    );
}
