import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export type TextButtonUISize = "xs" | "icon-xs" | "sm" | "normal";

const sizeClasses: Record<TextButtonUISize, string> = {
    xs: "px-1.5 text-xs",
    "icon-xs": "w-6 p-0 text-xs",
    sm: "px-2 text-xs",
    normal: "px-3 text-sm",
};

/** Also styles native links without changing their navigation semantics. */
export function textButtonUIClassName({
    size = "sm",
    className,
}: {
    size?: TextButtonUISize;
    className?: string;
} = {}) {
    return twMerge(
        clsx(
            "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-sm border-0 bg-transparent font-normal text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-default disabled:opacity-50 disabled:hover:text-muted-foreground",
            sizeClasses[size],
            className,
        ),
    );
}
