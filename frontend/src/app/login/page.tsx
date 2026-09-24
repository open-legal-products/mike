"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { login } from "@/app/lib/authApi";
import { Input } from "@/app/components/ui/input";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import Link from "next/link";
import { SiteLogo } from "@/app/components/site-logo";
import { useAuth } from "@/app/contexts/AuthContext";
import { cn } from "@/app/lib/utils";
import {
    authGlassCardClassName,
    authInputClassName,
} from "@/app/components/auth/authStyles";
import { AuthDivider } from "@/app/components/auth/AuthDivider";
import { SsoAuthButton } from "@/app/components/auth/SsoAuthButton";
import { GoogleAuthButton } from "@/app/components/auth/GoogleAuthButton";
import { FieldLabel } from "@/app/components/ui/form-field";
import {
    describeError,
    supportMailtoFor,
    type UserFacingError,
} from "@/app/lib/userFacingError";
import {
    AUTH_ERROR_MESSAGES,
    TOO_MANY_ATTEMPTS_MESSAGE,
    authMessages,
} from "@/app/lib/authMessages";

/**
 * The shared auth table (`@/app/lib/authMessages`) with this screen's
 * deltas. Anything not listed falls through to `describeError`, which
 * classifies by status (429, 5xx) or by the failure itself (offline,
 * connection dropped), so no login failure can collapse into "please try
 * again" without saying what happened.
 */
const LOGIN_ERROR_MESSAGES = authMessages({
    // Same text as invalid_credentials: saying "no such account" would let
    // anyone test which addresses are registered.
    user_not_found: AUTH_ERROR_MESSAGES.invalid_credentials,
    // Here the account exists; it is this sign-in route that is closed.
    signup_disabled: "This account can't be used to log in.",
    validation_failed: "Enter your email address and password.",
    invalid_request: "Enter your email address and password.",
    request_timeout: "The login request timed out. Try again.",
});

/** Classify a login failure into text a person can act on. */
function describeLoginError(error: unknown): UserFacingError {
    const described = describeError(error, {
        action: "log in",
        codeMessages: LOGIN_ERROR_MESSAGES,
        fallback: "Unable to log in right now. Try again.",
    });
    // A 429 without a GoTrue code still means "you tried too often".
    return described.kind === "rate_limited"
        ? { ...described, message: TOO_MANY_ATTEMPTS_MESSAGE }
        : described;
}

export default function LoginPage() {
    const router = useRouter();
    const {
        isAuthenticated,
        authLoading,
        authError,
        refreshSession,
        retrySession,
    } = useAuth();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<UserFacingError | null>(null);
    const [retryingSession, setRetryingSession] = useState(false);

    useEffect(() => {
        if (!authLoading && isAuthenticated) {
            router.replace("/onboarding/profile");
        }
    }, [authLoading, isAuthenticated, router]);

    const submitLogin = async () => {
        setLoading(true);
        setError(null);
        try {
            await login(email, password);
            await refreshSession();
            router.push("/onboarding/profile");
        } catch (caught: unknown) {
            setError(describeLoginError(caught));
        } finally {
            setLoading(false);
        }
    };

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        await submitLogin();
    };

    const handleRetrySession = async () => {
        setRetryingSession(true);
        setError(null);
        try {
            await retrySession();
        } catch (caught: unknown) {
            // The Retry button failing silently is what made the original
            // session error look permanent; say so instead.
            setError(
                describeError(caught, {
                    action: "restore your session",
                    fallback: "Unable to restore your session. Try again.",
                }),
            );
        } finally {
            setRetryingSession(false);
        }
    };

    return (
        <div className="relative flex min-h-dvh items-center justify-center bg-gray-50/80 px-6 py-10">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="lg" asLink />
            </div>
            <div className="w-full max-w-md">
                {/* Login Form */}
                <div className={cn(authGlassCardClassName, "mb-4")}>
                    <h2 className="mb-6 text-left text-2xl font-medium font-serif text-gray-950">
                        Log In
                    </h2>
                    <form onSubmit={handleLogin} className="space-y-4">
                        <div>
                            <FieldLabel htmlFor="email">Email</FieldLabel>
                            <Input
                                id="email"
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                required
                                className={`w-full ${authInputClassName}`}
                            />
                        </div>

                        <div>
                            <div className="flex items-start justify-between gap-3">
                                <FieldLabel htmlFor="password">
                                    Password
                                </FieldLabel>
                                <Link
                                    href="/forgot-password"
                                    className="text-xs font-medium text-gray-500 transition-colors hover:text-gray-950"
                                >
                                    Forgot password?
                                </Link>
                            </div>
                            <Input
                                id="password"
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                                className={`w-full ${authInputClassName}`}
                            />
                        </div>

                        {(error || authError) && (
                            <div
                                role="alert"
                                className="text-red-600 text-sm bg-red-50 p-3 rounded"
                            >
                                {error ? error.message : authError}
                                {!error && authError && (
                                    <button
                                        type="button"
                                        onClick={() => void handleRetrySession()}
                                        disabled={retryingSession}
                                        className="ml-2 underline underline-offset-2 disabled:no-underline disabled:opacity-60"
                                    >
                                        {retryingSession
                                            ? "Retrying..."
                                            : "Retry"}
                                    </button>
                                )}
                                {error?.retryable && (
                                    <button
                                        type="button"
                                        onClick={() => void submitLogin()}
                                        disabled={loading}
                                        className="ml-2 underline underline-offset-2 disabled:no-underline disabled:opacity-60"
                                    >
                                        Retry
                                    </button>
                                )}
                                {error?.supportable && (
                                    <a
                                        href={supportMailtoFor(
                                            error,
                                            "Failed to log in.",
                                        )}
                                        className="ml-2 underline underline-offset-2"
                                    >
                                        Contact support
                                    </a>
                                )}
                            </div>
                        )}

                        <div className="pt-2">
                            <PillButtonUI
                                type="submit"
                                tone="black"
                                size="normal"
                                disabled={loading}
                                className="w-full"
                            >
                                {loading ? "Logging in..." : "Log in"}
                            </PillButtonUI>
                        </div>
                        <AuthDivider />
                        <GoogleAuthButton
                            onError={setError}
                            disabled={loading}
                            onLoadingChange={setLoading}
                        />
                        <SsoAuthButton disabled={loading} />
                    </form>
                </div>
                <div className="text-center text-sm text-gray-500">
                    Don&apos;t have an account?{" "}
                    <Link
                        href="/signup"
                        className="font-medium transition-colors hover:text-gray-950"
                    >
                        Sign up
                    </Link>
                </div>
            </div>
        </div>
    );
}
