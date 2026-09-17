"use client";

import type { ComponentProps, ReactElement, ReactNode } from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export type ToggleSwitchUIProps = Omit<
    ComponentProps<"button">,
    "role" | "aria-checked" | "onClick" | "children"
> & {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    children?: ReactNode;
};

/** Canonical switch shared by the web app and Word add-in. */
export function ToggleSwitchUI({
    checked,
    onCheckedChange,
    type = "button",
    className,
    children,
    ...props
}: ToggleSwitchUIProps): ReactElement {
    return (
        <button
            type={type}
            role="switch"
            aria-checked={checked}
            onClick={() => onCheckedChange(!checked)}
            className={twMerge(
                clsx(
                    "flex w-fit items-center gap-2.5 text-sm text-gray-600 outline-none disabled:cursor-default disabled:opacity-40",
                    "focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2",
                    className,
                ),
            )}
            {...props}
        >
            <span
                data-slot="toggle-switch-track"
                aria-hidden="true"
                className={twMerge(
                    clsx(
                        "relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors duration-200",
                        checked
                            ? "bg-blue-600"
                            : "bg-gray-300 ring-1 ring-inset ring-gray-500",
                    ),
                )}
            >
                <span
                    data-slot="toggle-switch-thumb"
                    className={twMerge(
                        clsx(
                            "absolute left-1 top-1 h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-200",
                            checked ? "translate-x-4" : "translate-x-0",
                        ),
                    )}
                />
            </span>
            {children && <span>{children}</span>}
        </button>
    );
}
