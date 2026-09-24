"use client";

import Link from "next/link";
import { useEffect } from "react";
import { pillButtonUIClassName } from "@/shared/ui/PillButtonUI.styles";
import { reportError } from "@/app/lib/errorReporting";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { buildSupportMailto, describeError } from "@/shared/lib/userError";

export default function Error({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset?: () => void;
}) {
    useEffect(() => {
        // A render error that escaped every component boundary. The digest
        // is what Next prints for server-side render errors, so keep it.
        reportError(error, {
            tags: { component: "route-error-boundary", digest: error.digest },
        });
        console.error("App error:", error);
    }, [error]);

    // The render crashed, so nothing here may echo `error.message`. The
    // digest is the only detail worth handing over, and it travels in the
    // support email rather than as an explanation.
    const described = describeError(error, { action: "load this page" });
    const supportHref = buildSupportMailto(described, {
        page: typeof window !== "undefined" ? window.location.href : undefined,
        product: "web",
        note: `Error reference: ${error.digest ?? "unavailable"}`,
    });

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
                    <Link
                        href="/"
                        className={pillButtonUIClassName({
                            tone: reset ? "white" : "black",
                            size: "normal",
                        })}
                    >
                        Home
                    </Link>
                </div>

                <p className="mt-6 text-sm text-gray-500">
                    <a
                        href={supportHref}
                        className="font-medium underline underline-offset-2 transition-colors hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-300/45"
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
