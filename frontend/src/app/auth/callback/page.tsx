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
import {
    UserVisibleError,
    describeError,
    supportMailtoFor,
    type UserFacingError,
} from "@/app/lib/userFacingError";
import { LINK_SPENT_MESSAGE, authMessages } from "@/app/lib/authMessages";

/** The shared auth table with this screen's deltas: on the callback route
 *  every spent one-time code is the same spent confirmation link. */
const CALLBACK_ERROR_MESSAGES = authMessages({
    otp_expired: LINK_SPENT_MESSAGE,
});

/**
 * A spent or tampered link is a 4xx and deserves the "request a new one"
 * line; a dropped connection or a 5xx is not the link's fault and must not
 * send the user chasing a replacement email that would work fine.
 */
function describeCallbackError(
    error: unknown,
    action: string,
): UserFacingError {
    const described = describeError(error, {
        action,
        codeMessages: CALLBACK_ERROR_MESSAGES,
        fallback: LINK_SPENT_MESSAGE,
    });
    const linkIsSpent =
        described.status !== null &&
        described.status >= 400 &&
        described.status < 500 &&
        described.kind !== "rate_limited";
    return linkIsSpent && !described.code
        ? { ...described, message: LINK_SPENT_MESSAGE }
        : described;
}

function AuthCallbackContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { refreshSession } = useAuth();
    const [error, setError] = useState<UserFacingError | null>(null);
    const isErrorPreview =
        process.env.NODE_ENV !== "production" &&
        searchParams.get("preview") === "confirmation-error";
    const displayedMessage = isErrorPreview
        ? "This confirmation link is invalid or has expired."
        : (error?.message ?? null);

    useEffect(() => {
        if (isErrorPreview) return;

        let cancelled = false;

        async function completeAuth() {
            const providerError = authErrorDescription(
                window.location.search,
                window.location.hash,
            );
            if (providerError) {
                // Already a user-facing sentence chosen by authRedirects.
                setError(
                    describeError(
                        new UserVisibleError(providerError, {
                            kind: "validation",
                        }),
                        { action: "confirm your request" },
                    ),
                );
                return;
            }

            const code = searchParams.get("code");
            if (code) {
                try {
                    await exchangeAuthCode(code);
                    await refreshSession();
                } catch (caught) {
                    setError(
                        describeCallbackError(caught, "confirm your request"),
                    );
                    return;
                }
            } else {
                let session;
                try {
                    session = await getAuthSession();
                } catch (caught) {
                    setError(
                        describeCallbackError(caught, "confirm your request"),
                    );
                    return;
                }
                if (!session) {
                    setError(
                        describeError(
                            new UserVisibleError(LINK_SPENT_MESSAGE, {
                                kind: "validation",
                            }),
                            { action: "confirm your request" },
                        ),
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
                    {displayedMessage ? (
                        <>
                            <h1 className="text-2xl font-medium font-serif text-gray-950">
                                Unable to confirm
                            </h1>
                            <p
                                role="alert"
                                className="mt-3 text-sm leading-relaxed text-gray-600"
                            >
                                {displayedMessage}
                            </p>
                            {error?.supportable && (
                                <p className="mt-3 text-sm text-gray-500">
                                    <a
                                        href={supportMailtoFor(
                                            error,
                                            "Failed to complete an auth callback.",
                                        )}
                                        className="font-medium underline underline-offset-2"
                                    >
                                        Contact support
                                    </a>
                                </p>
                            )}
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
