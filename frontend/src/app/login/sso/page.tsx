"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { SiteLogo } from "@/app/components/site-logo";
import {
    authGlassCardClassName,
    authInputClassName,
} from "@/app/components/auth/authStyles";
import { FieldLabel } from "@/app/components/ui/form-field";
import { Input } from "@/app/components/ui/input";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { useAuth } from "@/app/contexts/AuthContext";
import { startSso } from "@/app/lib/authApi";
import {
    describeError,
    supportMailtoFor,
    type UserFacingError,
} from "@/app/lib/userFacingError";
import { authMessages } from "@/app/lib/authMessages";

/** The shared auth table with this screen's deltas: the address asked for
 *  here is a work address, so "valid email" is not specific enough. */
const SSO_ERROR_MESSAGES = authMessages({
    invalid_request: "Enter a valid company email address.",
    validation_failed: "Enter a valid company email address.",
    email_address_invalid: "Enter a valid company email address.",
});

export default function SsoLoginPage() {
    const router = useRouter();
    const { isAuthenticated, authLoading } = useAuth();
    const [email, setEmail] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<UserFacingError | null>(null);

    useEffect(() => {
        if (!authLoading && isAuthenticated) {
            router.replace("/onboarding/profile");
        }
    }, [authLoading, isAuthenticated, router]);

    const startSsoFlow = async () => {
        setLoading(true);
        setError(null);

        try {
            const { url } = await startSso(
                "/onboarding/profile",
                email.trim(),
            );
            window.location.assign(url);
        } catch (caught) {
            const described = describeError(caught, {
                action: "start single sign-on",
                codeMessages: SSO_ERROR_MESSAGES,
                fallback: "Unable to start single sign-on. Try again.",
            });
            setError(
                described.kind === "rate_limited"
                    ? {
                          ...described,
                          message:
                              "Too many attempts. Wait a moment and try again.",
                      }
                    : described,
            );
            setLoading(false);
        }
    };

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        await startSsoFlow();
    };

    return (
        <div className="relative flex min-h-dvh items-center justify-center bg-gray-50/80 px-6 py-10">
            <div className="absolute top-4 left-1/2 -translate-x-1/2 md:top-8">
                <SiteLogo size="lg" asLink />
            </div>
            <div className="w-full max-w-md">
                <div className={authGlassCardClassName}>
                    <div className="mb-6">
                        <h1 className="font-serif text-2xl font-medium text-gray-950">
                            SSO Login
                        </h1>
                    </div>

                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <FieldLabel htmlFor="sso-email">
                                Email
                            </FieldLabel>
                            <Input
                                id="sso-email"
                                type="email"
                                autoComplete="email"
                                autoCapitalize="none"
                                spellCheck={false}
                                placeholder="you@company.com"
                                value={email}
                                onChange={(event) =>
                                    setEmail(event.target.value)
                                }
                                required
                                disabled={loading}
                                className={authInputClassName}
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
                                        onClick={() => void startSsoFlow()}
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
                                            "Failed to start single sign-on.",
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
                                className="w-full"
                                disabled={loading || !email.trim()}
                                aria-busy={loading}
                            >
                                {loading && (
                                    <Loader2
                                        aria-hidden="true"
                                        className="h-4 w-4 animate-spin"
                                    />
                                )}
                                {loading ? "Continuing…" : "Continue"}
                            </PillButtonUI>
                        </div>
                    </form>
                </div>

                <div className="mt-4 text-center text-sm text-gray-500">
                    <Link
                        href="/login"
                        className="font-medium transition-colors hover:text-gray-950"
                    >
                        Back to login
                    </Link>
                </div>
            </div>
        </div>
    );
}
