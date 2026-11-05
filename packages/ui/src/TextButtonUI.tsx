"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";
import {
    textButtonUIClassName,
    type TextButtonUISize,
} from "./TextButtonUI.styles";

export type { TextButtonUISize } from "./TextButtonUI.styles";

export type TextButtonUIProps = ButtonHTMLAttributes<HTMLButtonElement> & {
    size?: TextButtonUISize;
    loading?: boolean;
};

/** Background-free action. Icon-only uses need an accessible label. */
export const TextButtonUI = forwardRef<HTMLButtonElement, TextButtonUIProps>(
    function TextButtonUI(
        {
            children,
            size = "sm",
            loading = false,
            disabled,
            type = "button",
            className,
            "aria-busy": ariaBusy,
            ...props
        },
        ref,
    ) {
        return (
            <button
                ref={ref}
                type={type}
                disabled={disabled || loading}
                aria-busy={loading ? true : ariaBusy}
                data-loading={loading || undefined}
                className={textButtonUIClassName({ size, className })}
                {...props}
            >
                {loading && (
                    <Loader2
                        aria-hidden="true"
                        className="h-3.5 w-3.5 animate-spin"
                    />
                )}
                <span
                    className={
                        loading
                            ? "contents [&_svg]:hidden [&_img]:hidden"
                            : "contents"
                    }
                >
                    {children}
                </span>
            </button>
        );
    },
);
