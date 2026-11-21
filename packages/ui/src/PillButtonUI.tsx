"use client";

import {
    type ButtonHTMLAttributes,
    type ReactElement,
    type ReactNode,
} from "react";
import { Loader2 } from "lucide-react";
import {
    pillButtonUIClassName,
    type PillButtonUISize,
    type PillButtonUITone,
} from "./PillButtonUI.styles";

export type {
    PillButtonUISize,
    PillButtonUITone,
} from "./PillButtonUI.styles";

export type PillButtonUIProps = Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "className"
> & {
    children?: ReactNode;
    className?: string;
    tone: PillButtonUITone;
    size?: PillButtonUISize;
    loading?: boolean;
};

const spinnerSizeClasses: Record<PillButtonUISize, string> = {
    xs: "h-3 w-3",
    "icon-xs": "h-3 w-3",
    sm: "h-3.5 w-3.5",
    normal: "h-4 w-4",
};

/** Canonical pill button shared by the web app and Word add-in. */
export function PillButtonUI({
    tone,
    size = "sm",
    type = "button",
    className,
    children,
    loading = false,
    disabled,
    "aria-busy": ariaBusy,
    ...props
}: PillButtonUIProps): ReactElement {
    return (
        <button
            type={type}
            className={pillButtonUIClassName({ tone, size, className })}
            disabled={disabled || loading}
            aria-busy={loading ? true : ariaBusy}
            data-loading={loading || undefined}
            {...props}
        >
            <PillButtonContentUI loading={loading} size={size}>
                {children}
            </PillButtonContentUI>
        </button>
    );
}

function PillButtonContentUI({
    children,
    loading,
    size,
}: {
    children: ReactNode;
    loading: boolean;
    size: PillButtonUISize;
}) {
    return (
        <>
            {loading && (
                <Loader2
                    data-slot="pill-button-spinner"
                    aria-hidden="true"
                    className={`${spinnerSizeClasses[size]} shrink-0 animate-spin`}
                />
            )}
            <span
                className={
                    loading
                        ? "contents [&_img]:hidden [&_svg]:hidden"
                        : "contents"
                }
            >
                {children}
            </span>
        </>
    );
}
