"use client";

import type { ComponentType } from "react";
import { cn } from "@/app/lib/utils";
import {
    LIQUID_GLASS_FLAT_CLASS,
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_SELECTED_CLASS,
    LIQUID_GLASS_SUBTLE_CLASS,
} from "@/shared/ui/LiquidGlassUI";

export interface SegmentedToggleOption<T extends string> {
    value: T;
    label: string;
    icon?: ComponentType<{ className?: string }>;
}

interface ModalSegmentedToggleProps<T extends string> {
    value: T;
    onChange: (value: T) => void;
    options: SegmentedToggleOption<T>[];
    disabled?: boolean;
    size?: "sm" | "md";
    /**
     * The track's glass. "subtle" suits a modal's tinted glass; "flat" gives
     * the track an edge on a white surface such as an editor pane.
     */
    surface?: "subtle" | "flat";
    className?: string;
}

// The track's padding and the gap between options, in rem: the sliding
// highlight is sized and moved from them.
const TRACK_PADDING_REM = 0.25;
const OPTION_GAP_REM = 0.25;

export function ModalSegmentedToggle<T extends string>({
    value,
    onChange,
    options,
    disabled = false,
    size = "md",
    surface = "subtle",
    className,
}: ModalSegmentedToggleProps<T>) {
    const activeIndex = options.findIndex((option) => option.value === value);
    const count = options.length;
    return (
        <div
            className={cn(
                "relative inline-grid gap-1 rounded-full p-1",
                surface === "flat"
                    ? LIQUID_GLASS_FLAT_CLASS
                    : LIQUID_GLASS_SUBTLE_CLASS,
                size === "sm" ? "h-8" : "h-9",
                className,
            )}
            style={{
                gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`,
            }}
        >
            {/* One highlight slides to the chosen option, rather than each
                option swapping its own fill. */}
            {activeIndex >= 0 && (
                <span
                    aria-hidden="true"
                    className={cn(
                        "pointer-events-none absolute rounded-full transition-transform duration-200 ease-out motion-reduce:transition-none",
                        LIQUID_GLASS_SELECTED_CLASS,
                    )}
                    style={{
                        top: `${TRACK_PADDING_REM}rem`,
                        bottom: `${TRACK_PADDING_REM}rem`,
                        left: `${TRACK_PADDING_REM}rem`,
                        width: `calc((100% - ${TRACK_PADDING_REM * 2}rem - ${(count - 1) * OPTION_GAP_REM}rem) / ${count})`,
                        transform: `translateX(calc(${activeIndex} * (100% + ${OPTION_GAP_REM}rem)))`,
                    }}
                />
            )}
            {options.map((option) => {
                const Icon = option.icon;
                const active = option.value === value;
                return (
                    <button
                        key={option.value}
                        type="button"
                        onClick={() => onChange(option.value)}
                        disabled={disabled}
                        aria-pressed={active}
                        className={cn(
                            "relative flex h-full items-center justify-center rounded-full text-xs transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-60",
                            size === "sm" ? "gap-1 px-3" : "gap-1.5 px-3",
                            active
                                ? "text-gray-900"
                                : `${LIQUID_GLASS_HOVER_CLASS} text-gray-500 hover:text-gray-700`,
                        )}
                    >
                        {Icon && (
                            <Icon
                                className={
                                    size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3"
                                }
                            />
                        )}
                        {option.label}
                    </button>
                );
            })}
        </div>
    );
}
