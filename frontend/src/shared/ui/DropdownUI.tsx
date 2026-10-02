"use client";

import * as React from "react";
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { LIQUID_GLASS_FLOAT_CLASS } from "./LiquidGlassUI";

function mergeClasses(...classes: Array<string | false | null | undefined>) {
    return twMerge(clsx(classes));
}

export const Dropdown = DropdownPrimitive.Root;
export const DropdownPortal = DropdownPrimitive.Portal;
export const DropdownTrigger = DropdownPrimitive.Trigger;

export const DropdownContent = React.forwardRef<
    React.ElementRef<typeof DropdownPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Content>
>(function DropdownContent({ className, ...props }, ref) {
    return (
        <DropdownPrimitive.Portal>
            <DropdownPrimitive.Content
                ref={ref}
                className={mergeClasses(
                    `theme-dropdown-surface z-[250] flex flex-col gap-1 rounded-xl p-1.5 text-xs text-gray-700 ${LIQUID_GLASS_FLOAT_CLASS} backdrop-blur-3xl`,
                    className,
                )}
                {...props}
            />
        </DropdownPrimitive.Portal>
    );
});

export const DropdownItem = React.forwardRef<
    React.ElementRef<typeof DropdownPrimitive.Item>,
    React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Item> & {
        selected?: boolean;
    }
>(function DropdownItem({ className, selected = false, ...props }, ref) {
    const { onPointerMove, ...itemProps } = props;

    return (
        <DropdownPrimitive.Item
            ref={ref}
            data-selected={selected ? "true" : undefined}
            className={mergeClasses(
                "theme-dropdown-item flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-2 outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&>*]:pointer-events-none",
                selected && "text-gray-900",
                className,
            )}
            onPointerMove={(event) => {
                onPointerMove?.(event);
                // Radix focuses an item on every mouse movement, which causes
                // highlight churn in Word's embedded webview. CSS hover still
                // covers pointer users; Radix retains keyboard navigation.
                if (event.pointerType === "mouse") event.preventDefault();
            }}
            {...itemProps}
        />
    );
});

export function DropdownLabel({
    className,
    ...props
}: React.ComponentPropsWithoutRef<
    typeof DropdownPrimitive.Label
>): React.ReactElement {
    return (
        <DropdownPrimitive.Label
            className={mergeClasses(
                "px-2.5 py-1 text-[10px] uppercase tracking-wider text-gray-400",
                className,
            )}
            {...props}
        />
    );
}

export function DropdownSeparator({
    className,
    ...props
}: React.ComponentPropsWithoutRef<
    typeof DropdownPrimitive.Separator
>): React.ReactElement {
    return (
        <DropdownPrimitive.Separator
            className={mergeClasses("mx-1 my-1 h-px bg-gray-200/70", className)}
            {...props}
        />
    );
}
