"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { login } from "@/app/lib/authApi";
import { Input } from "@/app/components/ui/input";
import { PillButton } from "@/app/components/ui/pill-button";
import Link from "next/link";
import { SiteLogo } from "@/app/components/site-logo";
import { useAuth } from "@/app/contexts/AuthContext";
import { cn } from "@/app/lib/utils";
import {
    authGlassCardClassName,
    authInputClassName,
} from "@/app/components/auth/authStyles";
import { AuthDivider } from "@/app/components/auth/AuthDivider";
import { GoogleAuthButton } from "@/app/components/auth/GoogleAuthButton";
import { FieldLabel } from "@/app/components/ui/form-field";
import { knownErrorCodeMessage } from "@/app/lib/userFacingError";

const LOGIN_ERROR_MESSAGES = {
    invalid_credentials: "The email or password is incorrect.",
    email_not_confirmed: "Confirm your email address before logging in.",
} as const;

// The Mac desktop shell's preload bridge. Only its local ("everything on
// this Mac") mode answers guestCredentials with a value — in a browser the
// bridge doesn't exist, and against a hosted server it returns null — so
// gating the guest button on the answer keeps this page byte-identical in
// behavior everywhere else.
type GuestCredentials = { email: string; password: string };
declare global {
    interface Window {
        mikeDesktop?: {
            guestCredentials?: () => Promise<GuestCredentials | null>;
        };
    }
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
            const { error } = await supabase.auth.signInWithPassword(guest);
            if (error) {
                // First use: the guest account doesn't exist yet. Local mode
                // autoconfirms signups, so this returns a session directly.
                const { error: signUpError } = await supabase.auth.signUp(guest);
                if (signUpError) throw signUpError;
            }
            // Same destination as a password login: OnboardingGate sends a
            // brand-new guest through onboarding and a returning one straight
            // on to /assistant.
            router.push("/onboarding/profile");
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
                            <div className="text-red-600 text-sm bg-red-50 p-3 rounded">
                                {error ?? authError}
                                {!error && authError && (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            void retrySession().catch(() => {})
                                        }
                                        className="ml-2 underline underline-offset-2"
                                    >
                                        Retry
                                    </button>
                                )}
                            </div>
                        )}

                        <div className="pt-2">
                            <PillButton
                                type="submit"
                                tone="black"
                                size="normal"
                                disabled={loading}
                                className="w-full"
                            >
                                {loading ? "Logging in..." : "Log in"}
                            </PillButton>
                        </div>
                        <AuthDivider />
                        <GoogleAuthButton
                            onError={setError}
                            disabled={loading}
                            onLoadingChange={setLoading}
                        />
                        {guest && (
                            <PillButton
                                type="button"
                                tone="white"
                                size="normal"
                                className="w-full"
                                onClick={handleGuestLogin}
                                disabled={loading}
                            >
                                Continue as guest
                            </PillButton>
                        )}
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
