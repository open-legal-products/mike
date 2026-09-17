"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { SiteLogo } from "@/app/components/site-logo";
import { pillButtonUIClassName } from "@/shared/ui/PillButtonUI.styles";
import { authGlassCardClassName } from "@/app/components/auth/authStyles";
import { authErrorDescription, safeAuthNext } from "@/app/lib/authRedirects";
import { exchangeAuthCode, getAuthSession } from "@/app/lib/authApi";
import { useAuth } from "@/app/contexts/AuthContext";

function AuthCallbackContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { refreshSession } = useAuth();
    const [error, setError] = useState<string | null>(null);
    const isErrorPreview =
        process.env.NODE_ENV !== "production" &&
        searchParams.get("preview") === "confirmation-error";
    const displayedError = isErrorPreview
        ? "This confirmation link is invalid or has expired."
        : error;

    useEffect(() => {
        if (isErrorPreview) return;

        let cancelled = false;

        async function completeAuth() {
            const providerError = authErrorDescription(
                window.location.search,
                window.location.hash,
            );
            if (providerError) {
                setError(providerError);
                return;
            }

            const code = searchParams.get("code");
            if (code) {
                try {
                    await exchangeAuthCode(code);
                    await refreshSession();
                } catch {
                    setError("This confirmation link is invalid or has expired.");
                    return;
                }
            } else {
                let session;
                try {
                    session = await getAuthSession();
                } catch {
                    setError("Authentication could not be completed. Please try again.");
                    return;
                }
                if (!session) {
                    setError(
                        "This confirmation link is invalid or has expired.",
                    );
                    return;
                }
            }

            if (!cancelled) {
                router.replace(safeAuthNext(searchParams.get("next")));
            }
        }

        void completeAuth();
        return () => {
            cancelled = true;
        };
    }, [isErrorPreview, refreshSession, router, searchParams]);

    return (
        <div className="relative flex min-h-dvh items-center justify-center bg-gray-50/80 px-6 py-10">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="lg" asLink />
            </div>
            <div className="w-full max-w-md">
                <div className={authGlassCardClassName}>
                    {displayedError ? (
                        <>
                            <h1 className="text-2xl font-medium font-serif text-gray-950">
                                Unable to confirm
                            </h1>
                            <p className="mt-3 text-sm leading-relaxed text-gray-600">
                                {displayedError}
                            </p>
                            <Link
                                href="/login"
                                className={pillButtonUIClassName({
                                    tone: "black",
                                    size: "normal",
                                    className: "mt-6",
                                })}
                            >
                                Return to login
                            </Link>
                        </>
                    ) : (
                        <>
                            <Loader2 className="h-6 w-6 animate-spin text-gray-500" />
                            <h1 className="mt-4 text-2xl font-medium font-serif text-gray-950">
                                Confirming your request
                            </h1>
                            <p className="mt-2 text-sm text-gray-500">
                                This should only take a moment.
                            </p>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

export default function AuthCallbackPage() {
    return (
        <Suspense fallback={null}>
            <AuthCallbackContent />
        </Suspense>
    );
}
