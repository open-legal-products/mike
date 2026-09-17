"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Input } from "@/app/components/ui/input";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { pillButtonUIClassName } from "@/shared/ui/PillButtonUI.styles";
import { SiteLogo } from "@/app/components/site-logo";
import {
    authGlassCardClassName,
    authInputClassName,
} from "@/app/components/auth/authStyles";
import {
    MIN_PASSWORD_LENGTH,
    minimumPasswordMessage,
} from "@/app/components/auth/passwordPolicy";
import { getAuthSession, updateAuthPassword } from "@/app/lib/authApi";
import { FieldLabel } from "@/app/components/ui/form-field";

function ResetPasswordContent() {
    const searchParams = useSearchParams();
    const [ready, setReady] = useState(false);
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [success, setSuccess] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const preview =
        process.env.NODE_ENV !== "production"
            ? searchParams.get("preview")
            : null;
    const isVerifyingPreview = preview === "reset-verifying";
    const isUnavailablePreview = preview === "reset-unavailable";
    const displayedReady = isUnavailablePreview || ready;
    const displayedError = isUnavailablePreview
        ? "This password-reset link is invalid or has expired."
        : error;
    const resetUnavailable =
        displayedReady && !!displayedError && !password && !confirmPassword;
    const verticallyCentered = !displayedReady || success || resetUnavailable;

    useEffect(() => {
        if (isVerifyingPreview || isUnavailablePreview) return;

        let cancelled = false;
        void getAuthSession()
            .then((session) => {
                if (cancelled) return;
                if (!session) {
                    setError(
                        "This password-reset link is invalid or has expired.",
                    );
                }
                setReady(true);
            })
            .catch(() => {
                if (cancelled) return;
                setError("This password-reset link is invalid or has expired.");
                setReady(true);
            });
        return () => {
            cancelled = true;
        };
    }, [isUnavailablePreview, isVerifyingPreview]);

    async function handleSubmit(event: React.FormEvent) {
        event.preventDefault();
        setError(null);
        if (password.length < MIN_PASSWORD_LENGTH) {
            setError(`${minimumPasswordMessage}.`);
            return;
        }
        if (password !== confirmPassword) {
            setError("Passwords do not match.");
            return;
        }

        setLoading(true);
        try {
            await updateAuthPassword(password, true);
            setSuccess(true);
        } catch {
            setError("Unable to update your password. Please try again.");
        } finally {
            setLoading(false);
        }
    }

    return (
        <div
            className={`relative flex min-h-dvh justify-center bg-gray-50/80 px-6 ${
                verticallyCentered
                    ? "items-center py-10"
                    : "items-start pb-10 pt-32 md:pt-40"
            }`}
        >
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="lg" asLink />
            </div>
            <div className="w-full max-w-md">
                <div className={authGlassCardClassName}>
                    {!displayedReady ? (
                        <div>
                            <Loader2 className="h-6 w-6 animate-spin text-gray-500" />
                            <h1 className="mt-4 font-serif text-2xl font-medium text-gray-950">
                                Verifying your reset link...
                            </h1>
                            <p className="mt-2 text-sm text-gray-500">
                                This should only take a moment.
                            </p>
                        </div>
                    ) : success ? (
                        <div>
                            <h1 className="text-2xl font-medium font-serif text-gray-950">
                                Password updated
                            </h1>
                            <p className="mt-3 text-sm leading-relaxed text-gray-600">
                                Your password has been changed. Log in again
                                with your new password.
                            </p>
                            <Link
                                href="/login"
                                className={pillButtonUIClassName({
                                    tone: "black",
                                    size: "normal",
                                    className: "mt-6",
                                })}
                            >
                                Log in
                            </Link>
                        </div>
                    ) : resetUnavailable ? (
                        <div>
                            <h1 className="text-2xl font-medium font-serif text-gray-950">
                                Reset link unavailable
                            </h1>
                            <p className="mt-3 text-sm leading-relaxed text-gray-600">
                                {displayedError}
                            </p>
                            <Link
                                href="/forgot-password"
                                className={pillButtonUIClassName({
                                    tone: "black",
                                    size: "normal",
                                    className: "mt-6",
                                })}
                            >
                                Request another link
                            </Link>
                        </div>
                    ) : (
                        <>
                            <h1 className="text-2xl font-medium font-serif text-gray-950">
                                Choose a new password
                            </h1>
                            <p className="mt-2 text-sm text-gray-500">
                                Use at least {MIN_PASSWORD_LENGTH} characters.
                            </p>
                            <form
                                onSubmit={handleSubmit}
                                className="mt-6 space-y-4"
                            >
                                <div>
                                    <FieldLabel htmlFor="password">
                                        New password
                                    </FieldLabel>
                                    <Input
                                        id="password"
                                        type="password"
                                        autoComplete="new-password"
                                        value={password}
                                        onChange={(event) =>
                                            setPassword(event.target.value)
                                        }
                                        required
                                        className={`w-full ${authInputClassName}`}
                                    />
                                </div>
                                <div>
                                    <FieldLabel htmlFor="confirmPassword">
                                        Confirm new password
                                    </FieldLabel>
                                    <Input
                                        id="confirmPassword"
                                        type="password"
                                        autoComplete="new-password"
                                        value={confirmPassword}
                                        onChange={(event) =>
                                            setConfirmPassword(
                                                event.target.value,
                                            )
                                        }
                                        required
                                        className={`w-full ${authInputClassName}`}
                                    />
                                </div>
                                {error && (
                                    <div className="rounded bg-red-50 p-3 text-sm text-red-600">
                                        {error}
                                    </div>
                                )}
                                <PillButtonUI
                                    type="submit"
                                    tone="black"
                                    size="normal"
                                    disabled={
                                        loading || !password || !confirmPassword
                                    }
                                    className="w-full"
                                >
                                    {loading
                                        ? "Updating password..."
                                        : "Update password"}
                                </PillButtonUI>
                            </form>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

export default function ResetPasswordPage() {
    return (
        <Suspense fallback={null}>
            <ResetPasswordContent />
        </Suspense>
    );
}
