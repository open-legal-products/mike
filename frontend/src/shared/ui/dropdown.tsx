"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { LIQUID_GLASS_FLOAT_CLASS } from "./LiquidGlassUI";

/**
 * The one dropdown implementation for the web app and the Word add-in: Radix
 * menu behaviour with the liquid-glass look.
 */

function mergeClasses(...classes: Array<string | false | null | undefined>) {
    return twMerge(clsx(classes));
}

// Above modals and side panels by default, so a menu opened from anywhere is
// never hidden behind its host. A caller can still pass its own `z-*` class.
const DROPDOWN_Z_INDEX_CLASS = "z-[250]";

// Rows are 4px apart, so a ring drawn outside a row would overlap its
// neighbours and be clipped by the menu's scroll area. Every focus ring inside
// a menu is therefore inset, including on controls that bring their own
// offset ring (a toolbar button collapsed into an overflow menu).
const DROPDOWN_INSET_RINGS_CLASS =
    "[&_:is(button,a,input,textarea,[role^='menuitem'],[role='option'])]:focus-visible:ring-inset [&_:is(button,a,input,textarea,[role^='menuitem'],[role='option'])]:focus-visible:ring-offset-0";

const DROPDOWN_CHROME_CLASS = `theme-dropdown-surface rounded-2xl ${LIQUID_GLASS_FLOAT_CLASS} ${DROPDOWN_INSET_RINGS_CLASS}`;

// Rows sit 4px apart. Anything that wraps rows inside a menu (a radio group,
// a scrolling list) uses this too, so spacing is the same at every level and
// call sites do not add their own `space-y-*`.
export const DROPDOWN_ROWS_CLASS = "flex flex-col gap-1";

// The highlighted item has to be distinguishable from a merely hovered one:
// the hover fill is a ~1% luminance step, so keyboard focus also gets a ring.
// An icon keeps an explicit `h-*`/`size-*` class and is 16px otherwise.
const DROPDOWN_ITEM_CLASS =
    "theme-dropdown-item relative flex shrink-0 cursor-pointer select-none items-center gap-2 rounded-lg px-3 py-1.5 text-xs text-gray-600 outline-none transition-colors hover:text-gray-900 focus:text-gray-900 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&>*]:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-']):not([class*='h-'])]:size-4";

const DROPDOWN_DESTRUCTIVE_CLASS =
    "text-red-600 hover:text-red-600 focus:text-red-600";

/**
 * Radix focuses an item on every mouse movement, which causes highlight churn
 * in Word's embedded webview. CSS hover still covers pointer users; Radix
 * retains keyboard navigation.
 */
function withoutMouseFocus<T extends Element>(
    onPointerMove: React.PointerEventHandler<T> | undefined,
): React.PointerEventHandler<T> {
    return (event) => {
        onPointerMove?.(event);
        if (event.pointerType === "mouse") event.preventDefault();
    };
}

export const Dropdown = DropdownPrimitive.Root;
export const DropdownTrigger = DropdownPrimitive.Trigger;

export const DropdownRadioGroup = React.forwardRef<
    React.ElementRef<typeof DropdownPrimitive.RadioGroup>,
    React.ComponentPropsWithoutRef<typeof DropdownPrimitive.RadioGroup>
>(function DropdownRadioGroup({ className, ...props }, ref) {
    return (
        <DropdownPrimitive.RadioGroup
            ref={ref}
            className={mergeClasses(DROPDOWN_ROWS_CLASS, className)}
            {...props}
        />
    );
});

export const DropdownContent = React.forwardRef<
    React.ElementRef<typeof DropdownPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Content>
>(function DropdownContent(
    { className, sideOffset = 4, onPointerDownOutside, ...props },
    ref,
) {
    const contentRef = React.useRef<HTMLDivElement | null>(null);
    return (
        <DropdownPrimitive.Portal>
            <DropdownPrimitive.Content
                ref={(node) => {
                    contentRef.current = node;
                    if (typeof ref === "function") ref(node);
                    else if (ref) ref.current = node;
                }}
                data-slot="dropdown-content"
                sideOffset={sideOffset}
                onPointerDownOutside={(event) => {
                    onPointerDownOutside?.(event);
                    // A press on the menu's own trigger is the trigger's to
                    // answer: it toggles the menu. Counting it as a press
                    // outside as well dismisses a menu the same press just
                    // reopened, which happens whenever the trigger is
                    // pressed while the menu is still animating shut (it
                    // can be, in a non-modal menu).
                    const triggerId =
                        contentRef.current?.getAttribute("aria-labelledby");
                    const trigger = triggerId
                        ? document.getElementById(triggerId)
                        : null;
                    if (trigger?.contains(event.target as Node)) {
                        event.preventDefault();
                    }
                }}
                className={mergeClasses(
                    DROPDOWN_CHROME_CLASS,
                    DROPDOWN_Z_INDEX_CLASS,
                    DROPDOWN_ROWS_CLASS,
                    "max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto p-1 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
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
        variant?: "default" | "destructive";
    }
>(function DropdownItem(
    { className, selected = false, variant = "default", onPointerMove, ...props },
    ref,
) {
    return (
        <DropdownPrimitive.Item
            ref={ref}
            data-slot="dropdown-item"
            data-selected={selected ? "true" : undefined}
            data-variant={variant}
            className={mergeClasses(
                DROPDOWN_ITEM_CLASS,
                selected && "text-gray-900",
                variant === "destructive" && DROPDOWN_DESTRUCTIVE_CLASS,
                className,
            )}
            onPointerMove={withoutMouseFocus(onPointerMove)}
            {...props}
        />
    );
});

export const DropdownRadioItem = React.forwardRef<
    React.ElementRef<typeof DropdownPrimitive.RadioItem>,
    React.ComponentPropsWithoutRef<typeof DropdownPrimitive.RadioItem>
>(function DropdownRadioItem({ className, onPointerMove, ...props }, ref) {
    return (
        <DropdownPrimitive.RadioItem
            ref={ref}
            data-slot="dropdown-radio-item"
            className={mergeClasses(DROPDOWN_ITEM_CLASS, className)}
            onPointerMove={withoutMouseFocus(onPointerMove)}
            {...props}
        />
    );
});

export const DropdownCheckboxItem = React.forwardRef<
    React.ElementRef<typeof DropdownPrimitive.CheckboxItem>,
    React.ComponentPropsWithoutRef<typeof DropdownPrimitive.CheckboxItem>
>(function DropdownCheckboxItem(
    { className, children, onPointerMove, ...props },
    ref,
) {
    return (
        <DropdownPrimitive.CheckboxItem
            ref={ref}
            data-slot="dropdown-checkbox-item"
            className={mergeClasses(DROPDOWN_ITEM_CLASS, "pl-3 pr-8", className)}
            onPointerMove={withoutMouseFocus(onPointerMove)}
            {...props}
        >
            {children}
            <span className="absolute right-2 flex size-3.5 items-center justify-center">
                <DropdownPrimitive.ItemIndicator>
                    <Check className="size-4" />
                </DropdownPrimitive.ItemIndicator>
            </span>
        </DropdownPrimitive.CheckboxItem>
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
            data-slot="dropdown-label"
            className={mergeClasses(
                "shrink-0 px-3 py-1 text-[10px] uppercase tracking-wider text-gray-400",
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
            data-slot="dropdown-separator"
            className={mergeClasses(
                "mx-1 h-px shrink-0 bg-gray-200/70",
                className,
            )}
            {...props}
        />
    );
}

/**
 * A menu opened at a screen position instead of from a visible button: a
 * right-click menu. Render it only while it should be open. It is non-modal,
 * so right-clicking somewhere else closes it and opens the next one in a
 * single gesture, and it stays inside the viewport.
 */
export function DropdownAtPoint({
    point,
    onClose,
    children,
    followPoint = false,
    ...contentProps
}: {
    point: { x: number; y: number };
    onClose: () => void;
    children: React.ReactNode;
    /**
     * Treat a changed point as the same menu moving (it is anchored to
     * something that reflows, like highlighted text) rather than as a new
     * menu opened somewhere else.
     */
    followPoint?: boolean;
} & Omit<
    React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Content>,
    "children"
>): React.ReactElement {
    return (
        <Dropdown
            // A new point is a new menu. Without the remount, a right-click
            // while one is open can leave it positioned at the old point.
            key={followPoint ? undefined : `${point.x},${point.y}`}
            open
            modal={false}
            onOpenChange={(open) => {
                if (!open) onClose();
            }}
        >
            {/* Radix positions a menu against its trigger, so the trigger is
                an invisible point. It is portalled because an ancestor with a
                transform or backdrop filter would re-anchor `position: fixed`. */}
            {createPortal(
                <DropdownTrigger asChild>
                    <span
                        aria-hidden="true"
                        style={{
                            position: "fixed",
                            left: point.x,
                            top: point.y,
                            width: 0,
                            height: 0,
                            pointerEvents: "none",
                        }}
                    />
                </DropdownTrigger>,
                document.body,
            )}
            <DropdownContent
                align="start"
                sideOffset={0}
                // There is no real trigger to hand focus back to.
                onCloseAutoFocus={(event) => event.preventDefault()}
                // A zero-size trigger gives the positioner nothing to watch
                // for movement, so a followed point is re-read every frame.
                updatePositionStrategy={followPoint ? "always" : undefined}
                {...contentProps}
            >
                {children}
            </DropdownContent>
        </Dropdown>
    );
}

/**
 * The menu's surface and row styling for popovers that are not menus: a
 * combobox's option list, for example, where focus has to stay in the text
 * field. Use `DropdownContent` and `DropdownItem` for anything a button opens.
 */
export const DropdownSurface = React.forwardRef<
    HTMLDivElement,
    React.ComponentPropsWithoutRef<"div">
>(function DropdownSurface({ className, ...props }, ref) {
    return (
        <div
            ref={ref}
            className={mergeClasses(
                DROPDOWN_CHROME_CLASS,
                DROPDOWN_Z_INDEX_CLASS,
                className,
            )}
            {...props}
        />
    );
});

export const DropdownButton = React.forwardRef<
    HTMLButtonElement,
    React.ComponentPropsWithoutRef<"button">
>(function DropdownButton({ className, type = "button", ...props }, ref) {
    return (
        <button
            ref={ref}
            type={type}
            className={mergeClasses(
                "theme-dropdown-item cursor-pointer text-xs text-gray-600 transition-colors focus:text-gray-900 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40",
                className,
            )}
            {...props}
        />
    );
});
