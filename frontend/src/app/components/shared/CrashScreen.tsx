"use client";

import type { ReactNode } from "react";
import { useCrashBoundary } from "@/app/hooks/useCrashBoundary";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { textButtonUIClassName } from "@/shared/ui/TextButtonUI.styles";

/**
 * The body of `app/error.tsx` and `app/global-error.tsx`: one markup, so the
 * two crash screens cannot drift apart. Reports the crash once and never
 * shows `error.message` (see useCrashBoundary); the digest is the only
 * detail on screen and in the support email.
 */
export function CrashScreen({
    error,
    reset,
    component,
    level,
    secondaryAction,
}: {
    error: Error & { digest?: string };
    reset?: () => void;
    component: string;
    level?: "fatal";
    /** Rendered after "Try again": white when Try again is shown, else black. */
    secondaryAction: (tone: "white" | "black") => ReactNode;
}) {
    const supportHref = useCrashBoundary(error, { component, level });

    return (
        <div className="min-h-screen bg-white flex items-center justify-center px-4">
            <div className="text-center max-w-md">
                <h1 className="text-3xl font-eb-garamond font-light text-gray-900 mb-3">
                    Something went wrong
                </h1>
                <p className="text-[0.9375rem] text-gray-500 leading-relaxed mb-8">
                    This page didn&apos;t load. Try again, and contact support
                    if it keeps happening.
                </p>

                <div className="flex flex-wrap items-center justify-center gap-3">
                    {reset && (
                        <PillButtonUI
                            type="button"
                            tone="black"
                            size="normal"
                            onClick={() => reset()}
                        >
                            Try again
                        </PillButtonUI>
                    )}
                    {secondaryAction(reset ? "white" : "black")}
                </div>

                <p className="mt-6 text-sm text-gray-500">
                    <a
                        href={supportHref}
                        className={textButtonUIClassName({
                            size: "normal",
                            className: "px-0",
                        })}
                    >
                        Contact support
                    </a>
                    {error.digest && (
                        <span className="ml-2 text-gray-400">
                            Error reference: {error.digest}
                        </span>
                    )}
                </p>
            </div>
        </div>
    );
}
