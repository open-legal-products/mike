"use client";

import * as React from "react";
import {
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuRadioItem,
} from "@/app/components/ui/dropdown-menu";
import { cn } from "@/app/lib/utils";
import { LIQUID_GLASS_FLOAT_CLASS } from "@/shared/ui/LiquidGlassUI";

const LIQUID_DROPDOWN_CHROME_CLASS =
    "theme-dropdown-surface rounded-2xl backdrop-blur-2xl";
const LIQUID_DROPDOWN_SURFACE_CLASS =
    `${LIQUID_DROPDOWN_CHROME_CLASS} ${LIQUID_GLASS_FLOAT_CLASS}`;

// The highlighted item has to be distinguishable from a merely hovered one:
// `app-surface-hover` is a ~1% luminance step, so focus also gets a ring.
const LIQUID_DROPDOWN_ITEM_CLASS =
    "theme-dropdown-item cursor-pointer text-xs text-gray-600 transition-colors focus:text-gray-900 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40";

export function LiquidDropdownContent({
    className,
    ...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
    return (
        <DropdownMenuContent
            className={cn(LIQUID_DROPDOWN_CHROME_CLASS, className)}
            {...props}
        />
    );
}

export const LiquidDropdownSurface = React.forwardRef<
    HTMLDivElement,
    React.ComponentPropsWithoutRef<"div">
>(function LiquidDropdownSurface({ className, ...props }, ref) {
    return (
        <div
            ref={ref}
            className={cn(LIQUID_DROPDOWN_SURFACE_CLASS, className)}
            {...props}
        />
    );
});

export function LiquidDropdownItem({
    className,
    selected = false,
    ...props
}: React.ComponentProps<typeof DropdownMenuItem> & {
    selected?: boolean;
}) {
    return (
        <DropdownMenuItem
            data-selected={selected ? "true" : undefined}
            className={cn(
                LIQUID_DROPDOWN_ITEM_CLASS,
                selected && "text-gray-900",
                className,
            )}
            {...props}
        />
    );
}

export const LiquidDropdownButton = React.forwardRef<
    HTMLButtonElement,
    React.ComponentPropsWithoutRef<"button">
>(function LiquidDropdownButton({ className, type = "button", ...props }, ref) {
    return (
        <button
            ref={ref}
            type={type}
            className={cn(LIQUID_DROPDOWN_ITEM_CLASS, className)}
            {...props}
        />
    );
});

export function LiquidDropdownRadioItem({
    className,
    ...props
}: React.ComponentProps<typeof DropdownMenuRadioItem>) {
    return (
        <DropdownMenuRadioItem
            className={cn(LIQUID_DROPDOWN_ITEM_CLASS, className)}
            {...props}
        />
    );
}

export function LiquidDropdownCheckboxItem({
    className,
    ...props
}: React.ComponentProps<typeof DropdownMenuCheckboxItem>) {
    return (
        <DropdownMenuCheckboxItem
            className={cn(
                LIQUID_DROPDOWN_ITEM_CLASS,
                "pl-3 pr-8 [&>span]:right-2 [&>span]:left-auto",
                className,
            )}
            {...props}
        />
    );
}
