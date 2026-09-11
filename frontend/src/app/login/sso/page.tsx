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
import { PillButton } from "@/app/components/ui/pill-button";
import { useAuth } from "@/app/contexts/AuthContext";
import { startSso } from "@/app/lib/authApi";
import { knownErrorCodeMessage } from "@/app/lib/userFacingError";

const SSO_ERROR_MESSAGES = {
    invalid_request: "Enter a valid company email address.",
    sso_domain_not_allowed:
        "Single sign-on is not available for this email domain.",
    sso_disabled: "Single sign-on is not enabled.",
    sso_unavailable:
        "Unable to start single sign-on for this email domain.",
} as const;

export default function SsoLoginPage() {
    const router = useRouter();
    const { isAuthenticated, authLoading } = useAuth();
    const [email, setEmail] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!authLoading && isAuthenticated) {
            router.replace("/onboarding/profile");
        }
    }, [authLoading, isAuthenticated, router]);

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        setLoading(true);
        setError(null);

        try {
            const { url } = await startSso(
                "/onboarding/profile",
                email.trim(),
            );
            window.location.assign(url);
        } catch (caught) {
            setError(
                knownErrorCodeMessage(
                    caught,
                    SSO_ERROR_MESSAGES,
                    "Unable to start single sign-on. Please try again.",
                ),
            );
            setLoading(false);
        }
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
                                {error}
                            </div>
                        )}

                        <div className="pt-2">
                            <PillButton
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
                            </PillButton>
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
