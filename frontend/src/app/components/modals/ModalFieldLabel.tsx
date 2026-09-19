"use client";

import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/app/lib/utils";

type ModalFieldLabelProps = ComponentPropsWithoutRef<"label"> & {
    children: ReactNode;
    as?: "label" | "p" | "span";
};

export function ModalFieldLabel({
    as = "label",
    children,
    className,
    ...props
}: ModalFieldLabelProps) {
    const classes = cn(
        "mb-2 block text-xs font-medium text-gray-700",
        className,
    );

    if (as === "p") return <p className={classes}>{children}</p>;
    if (as === "span") return <span className={classes}>{children}</span>;

    return (
        <label className={classes} {...props}>
            {children}
        </label>
    );
}
