"use client";

import type { ButtonHTMLAttributes, ReactElement, ReactNode } from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export type CitationPillUIProps = Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "children" | "className"
> & {
    children: ReactNode;
    className?: string;
    active?: boolean;
};

const BASE_CLASS_NAME =
    "inline-flex h-4 w-4 items-center justify-center rounded-full bg-gray-200/80 text-[12px] font-serif font-medium text-gray-800 transition-colors hover:bg-gray-200 hover:text-gray-950";

/** Canonical numbered citation control shared by web and Word surfaces. */
export function CitationPillUI({
    type = "button",
    className,
    active = false,
    ...props
}: CitationPillUIProps): ReactElement {
    return (
        <button
            type={type}
            aria-current={active ? "true" : undefined}
            aria-pressed={active}
            data-active={active ? "true" : undefined}
            className={twMerge(
                clsx(
                    BASE_CLASS_NAME,
                    active &&
                        "!bg-blue-100 !text-blue-900 hover:!bg-blue-100 hover:!text-blue-900 dark:!bg-blue-950 dark:!text-white dark:hover:!bg-blue-900 dark:hover:!text-white",
                    className,
                ),
            )}
            {...props}
        />
    );
}
