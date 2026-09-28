"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthApiError, login, signup } from "@/app/lib/authApi";
import { completeUserOnboarding, getUserProfile } from "@/app/lib/mikeApi";
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
import { knownErrorCodeMessage } from "@/app/lib/userFacingError";
import type { DesktopGuestCredentials as GuestCredentials } from "@/app/lib/desktopLocalModel";

const LOGIN_ERROR_MESSAGES = {
    invalid_credentials: "The email or password is incorrect.",
    email_not_confirmed: "Confirm your email address before logging in.",
} as const;

// The Mac desktop shell's preload bridge. Only its local ("everything on
// this Mac") mode answers guestCredentials with a value — in a browser the
// bridge doesn't exist, and against a hosted server it returns null — so
// gating the guest button on the answer keeps this page byte-identical in
// behavior everywhere else.
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
    const [error, setError] = useState<string | null>(null);
    const [guest, setGuest] = useState<GuestCredentials | null>(null);

    useEffect(() => {
        if (!authLoading && isAuthenticated) {
            router.replace("/onboarding/profile");
        }
    }, [authLoading, isAuthenticated, router]);

    useEffect(() => {
        let cancelled = false;
        window.mikeDesktop
            ?.guestCredentials?.()
            .then((creds) => {
                if (!cancelled && creds?.email && creds?.password) {
                    setGuest(creds);
                }
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, []);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        try {
            await login(email, password);
            await refreshSession();
            router.push("/onboarding/profile");
        } catch (error: unknown) {
            setError(
                knownErrorCodeMessage(
                    error,
                    LOGIN_ERROR_MESSAGES,
                    "Unable to log in right now. Please try again.",
                ),
            );
        } finally {
            setLoading(false);
        }
    };

    const handleGuestLogin = async () => {
        if (!guest) return;
        setLoading(true);
        setError(null);

        try {
            try {
                await login(guest.email, guest.password);
            } catch (loginError) {
                if (
                    !(loginError instanceof AuthApiError) ||
                    loginError.code !== "invalid_credentials"
                ) {
                    throw loginError;
                }
                // First use: the guest account doesn't exist yet. Local mode
                // autoconfirms signups, so /signup returns a session directly
                // and requiresEmailConfirmation is false; if a deployment ever
                // did require confirmation there is no inbox to confirm from,
                // so surface that as an error rather than a dead end.
                const result = await signup(
                    guest.email,
                    guest.password,
                    "/onboarding/profile",
                );
                if (result.requiresEmailConfirmation) {
                    throw new Error(
                        "Guest sign-in needs an auto-confirming local stack.",
                    );
                }
            }
            // A local workspace needs no cloud account or practice questionnaire.
            // These optional details remain editable in Settings.
            const profile = await getUserProfile();
            if (!profile.onboardingComplete) await completeUserOnboarding();
            // Session lives in the httpOnly cookie the auth routes set, so the
            // context has to re-read it before any gated route will let us in.
            await refreshSession();
            router.push("/assistant");
        } catch (error: unknown) {
            setError(
                knownErrorCodeMessage(
                    error,
                    LOGIN_ERROR_MESSAGES,
                    "Unable to continue as guest right now. Please try again.",
                ),
            );
        } finally {
            setLoading(false);
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
                        {guest ? "Your workspace on this Mac" : "Log In"}
                    </h2>
                    {guest && (
                        <div className="mb-6 space-y-3">
                            <p className="text-sm text-muted-foreground">
                                Start without an account. Your work is saved on
                                this Mac. You can add your practice details
                                later in Settings.
                            </p>
                            <PillButtonUI
                                type="button"
                                tone="black"
                                size="normal"
                                className="w-full"
                                onClick={handleGuestLogin}
                                disabled={loading}
                            >
                                {loading
                                    ? "Opening workspace…"
                                    : "Continue on this Mac"}
                            </PillButtonUI>
                        </div>
                    )}
                    <details open={!guest}>
                        <summary
                            hidden={!guest}
                            className="mb-4 cursor-pointer text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
                        >
                            Use a separate local account
                        </summary>
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
                                    onChange={(e) =>
                                        setPassword(e.target.value)
                                    }
                                    required
                                    className={`w-full ${authInputClassName}`}
                                />
                            </div>

                            {(error || authError) && (
                                <div className="text-red-600 text-sm bg-red-50 p-3 rounded">
                                    {error ?? authError}
                                    {!error && authError && (
                                        <button
                                            type="button"
                                            onClick={() =>
                                                void retrySession().catch(
                                                    () => {},
                                                )
                                            }
                                            className="ml-2 underline underline-offset-2"
                                        >
                                            Retry
                                        </button>
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
                            {!guest && (
                                <>
                                    <AuthDivider />
                                    <GoogleAuthButton
                                        onError={setError}
                                        disabled={loading}
                                        onLoadingChange={setLoading}
                                    />
                                    <SsoAuthButton disabled={loading} />
                                </>
                            )}
                        </form>
                    </details>
                    {guest && error && (
                        <p
                            role="alert"
                            className="mt-3 text-sm text-destructive"
                        >
                            {error}
                        </p>
                    )}
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
