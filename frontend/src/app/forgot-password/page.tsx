"use client";

import { useState } from "react";
import Link from "next/link";
import { Input } from "@/app/components/ui/input";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { pillButtonUIClassName } from "@/shared/ui/PillButtonUI.styles";
import { SiteLogo } from "@/app/components/site-logo";
import {
    authGlassCardClassName,
    authInputClassName,
} from "@/app/components/auth/authStyles";
import { requestPasswordReset } from "@/app/lib/authApi";
import { FieldLabel } from "@/app/components/ui/form-field";
import {
    describeError,
    supportMailtoFor,
    type UserErrorKind,
    type UserFacingError,
} from "@/app/lib/userFacingError";

/**
 * Failures that mean the request never reached Mike. Telling the user to
 * check their email after one of these would be a lie, and none of them
 * depends on whether the address exists, so saying so leaks nothing.
 */
const DELIVERY_FAILURE_KINDS: ReadonlySet<UserErrorKind> = new Set([
    "offline",
    "network",
    "timeout",
    "unavailable",
    "server",
    // The 10-per-hour reset limiter and a blocked request both answer before
    // any address is looked at, so neither says whether the account exists.
    // Showing "check your email" for them would promise mail nobody sent.
    "rate_limited",
    "forbidden",
]);

export default function ForgotPasswordPage() {
    const [email, setEmail] = useState("");
    const [loading, setLoading] = useState(false);
    const [submitted, setSubmitted] = useState(false);
    const [error, setError] = useState<UserFacingError | null>(null);

    async function sendResetLink() {
        setLoading(true);
        setError(null);
        try {
            await requestPasswordReset(email.trim());
            setSubmitted(true);
        } catch (caught) {
            const described = describeError(caught, {
                action: "send the reset link",
                fallback:
                    "Mike couldn't send the reset link. Try again in a moment.",
            });
            if (DELIVERY_FAILURE_KINDS.has(described.kind)) {
                setError(described);
                return;
            }
            // Every other outcome gets the same response for existing and
            // unknown addresses, so this screen cannot be used to enumerate
            // Mike accounts.
            setSubmitted(true);
        } finally {
            setLoading(false);
        }
    }

    async function handleSubmit(event: React.FormEvent) {
        event.preventDefault();
        await sendResetLink();
    }

    return (
        <div
            className={`relative flex min-h-dvh justify-center bg-gray-50/80 px-6 ${
                submitted
                    ? "items-center py-10"
                    : "items-start pb-10 pt-32 md:pt-40"
            }`}
        >
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="lg" asLink />
            </div>
            <div className="w-full max-w-md">
                <div className={authGlassCardClassName}>
                    {submitted ? (
                        <div>
                            <h1 className="text-2xl font-medium font-serif text-gray-950">
                                Check your email
                            </h1>
                            <p className="mt-3 text-sm leading-relaxed text-gray-600">
                                If an account exists for {email.trim()}, we sent
                                a password-reset link. The link expires and can
                                only be used once.
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
                        </div>
                    ) : (
                        <>
                            <h1 className="text-2xl font-medium font-serif text-gray-950">
                                Reset your password
                            </h1>
                            <p className="mt-2 text-sm leading-relaxed text-gray-500">
                                Enter your account email and we will send you a
                                secure reset link.
                            </p>
                            <form
                                onSubmit={handleSubmit}
                                className="mt-6 space-y-4"
                            >
                                <div>
                                    <FieldLabel htmlFor="email">
                                        Email
                                    </FieldLabel>
                                    <Input
                                        id="email"
                                        type="email"
                                        autoComplete="email"
                                        value={email}
                                        onChange={(event) =>
                                            setEmail(event.target.value)
                                        }
                                        required
                                        className={`w-full ${authInputClassName}`}
                                    />
                                </div>
                                {error && (
                                    <div
                                        role="alert"
                                        className="rounded bg-red-50 p-3 text-sm text-red-600"
                                    >
                                        {error.message}
                                        {error.retryable && (
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    void sendResetLink()
                                                }
                                                disabled={loading}
                                                className="ml-2 underline underline-offset-2 disabled:no-underline disabled:opacity-60"
                                            >
                                                Retry
                                            </button>
                                        )}
                                        {error.supportable && (
                                            <a
                                                href={supportMailtoFor(
                                                    error,
                                                    "Failed to request a password reset.",
                                                )}
                                                className="ml-2 underline underline-offset-2"
                                            >
                                                Contact support
                                            </a>
                                        )}
                                    </div>
                                )}
                                <PillButtonUI
                                    type="submit"
                                    tone="black"
                                    size="normal"
                                    disabled={loading || !email.trim()}
                                    className="w-full"
                                >
                                    {loading
                                        ? "Sending reset link..."
                                        : "Send reset link"}
                                </PillButtonUI>
                            </form>
                            <div className="mt-5 text-center">
                                <Link
                                    href="/login"
                                    className="text-sm font-medium text-gray-500 transition-colors hover:text-gray-950"
                                >
                                    Return to login
                                </Link>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
