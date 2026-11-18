"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
    InputUI,
    PillButtonUI,
    authGlassCardUIClassName,
    authInputUIClassName,
    noticeActionClassName,
} from "@mike/ui";
import { AuthApiError, setupFirstAccount } from "@/app/lib/authApi";
import { SiteLogo } from "@/app/components/site-logo";
import { FullScreenLoader } from "@/app/components/shared/FullScreenLoader";
import { useAuth } from "@/app/contexts/AuthContext";
import { useSignInOptions } from "@/app/hooks/useSignInOptions";
import { cn } from "@/app/lib/utils";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { FieldLabel } from "@/app/components/ui/form-field";
import {
    MIN_PASSWORD_LENGTH,
    isPasswordTooLong,
    maximumPasswordMessage,
    minimumPasswordMessage,
} from "@/app/components/auth/passwordPolicy";
import { TOO_MANY_ATTEMPTS_MESSAGE, authMessages } from "@/app/lib/authMessages";
import {
    UserVisibleError,
    describeError,
    reportFault,
    supportMailtoFor,
    type UserFacingError,
} from "@/app/lib/userFacingError";

const SETUP_ERROR_MESSAGES = authMessages({
    validation_failed: "Check your email address and password and try again.",
    invalid_request: "Check your email address and password and try again.",
    setup_complete: "This Mike instance is already set up. Log in instead.",
    request_timeout: "The request timed out. Try again.",
});

function localSetupError(message: string): UserFacingError {
    return describeError(new UserVisibleError(message, { kind: "validation" }), {
        action: "create the first account",
    });
}

function describeSetupError(error: unknown): UserFacingError {
    const described = reportFault(error, {
        action: "create the first account",
        codeMessages: SETUP_ERROR_MESSAGES,
        fallback: "Unable to create the account right now. Try again.",
        operation: "auth.setup",
    });
    return described.kind === "rate_limited"
        ? { ...described, message: TOO_MANY_ATTEMPTS_MESSAGE }
        : described;
}

/**
 * First-run setup. A deployment that starts with no accounts (the Vercel
 * Deploy button) sends its first visitor here instead of asking for an
 * admin login at deploy time. The account is created confirmed, because the
 * deployment cannot send confirmation email yet, and signed straight in.
 */
export default function SetupPage() {
    const router = useRouter();
    const { isAuthenticated, authLoading, refreshSession } = useAuth();
    const { options, loaded } = useSignInOptions();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<UserFacingError | null>(null);
    const [alreadySetUp, setAlreadySetUp] = useState(false);

    // Once an account exists this screen has nothing to offer.
    useEffect(() => {
        if (!authLoading && isAuthenticated && !loading) {
            router.replace("/onboarding/profile");
        } else if (loaded && !options.setupRequired && !loading) {
            router.replace("/login");
        }
    }, [authLoading, isAuthenticated, loaded, loading, options.setupRequired, router]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        if (password !== confirmPassword) {
            setError(localSetupError("The two passwords don't match."));
            return;
        }
        if (password.length < MIN_PASSWORD_LENGTH) {
            setError(localSetupError(`${minimumPasswordMessage}.`));
            return;
        }
        if (isPasswordTooLong(password)) {
            setError(localSetupError(maximumPasswordMessage));
            return;
        }

        setLoading(true);
        try {
            await setupFirstAccount(email.trim(), password);
            await refreshSession();
            router.push("/onboarding/profile");
        } catch (caught: unknown) {
            if (caught instanceof AuthApiError && caught.code === "setup_complete") {
                setAlreadySetUp(true);
            }
            setError(describeSetupError(caught));
            setLoading(false);
        }
    };

    if (!loaded || (!options.setupRequired && !alreadySetUp)) {
        return <FullScreenLoader />;
    }

    return (
        <div className="relative flex min-h-dvh items-center justify-center bg-gray-50/80 px-6 py-24">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="lg" />
            </div>
            <div className="w-full max-w-md">
                <div className={cn(authGlassCardUIClassName, "mb-4")}>
                    <h1 className="text-left text-2xl font-medium font-serif text-gray-950">
                        Set up Mike
                    </h1>
                    <p className="mt-2 mb-6 text-sm leading-relaxed text-gray-600">
                        Your deployment is ready. Create the first account to
                        start using it.
                    </p>

                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <FieldLabel htmlFor="email">Email</FieldLabel>
                            <InputUI
                                id="email"
                                type="email"
                                autoComplete="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                required
                                className={`w-full ${authInputUIClassName}`}
                            />
                        </div>

                        <div>
                            <FieldLabel htmlFor="password">Password</FieldLabel>
                            <InputUI
                                id="password"
                                type="password"
                                autoComplete="new-password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder={`Min. ${MIN_PASSWORD_LENGTH} Characters`}
                                required
                                className={`w-full ${authInputUIClassName}`}
                            />
                        </div>

                        <div>
                            <FieldLabel htmlFor="confirmPassword">
                                Confirm Password
                            </FieldLabel>
                            <InputUI
                                id="confirmPassword"
                                type="password"
                                autoComplete="new-password"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                required
                                className={`w-full ${authInputUIClassName}`}
                            />
                        </div>

                        <div className="space-y-3 pt-2">
                            <div className="text-center text-xs text-gray-500">
                                By creating an account, you agree to our{" "}
                                <Link
                                    href="https://mikeoss.com/terms"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-600 hover:underline"
                                >
                                    Terms of Use
                                </Link>{" "}
                                and{" "}
                                <Link
                                    href="https://mikeoss.com/privacy"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-600 hover:underline"
                                >
                                    Privacy Policy
                                </Link>
                            </div>
                            <PillButtonUI
                                type="submit"
                                tone="black"
                                size="normal"
                                disabled={loading || alreadySetUp}
                                className="w-full"
                            >
                                {loading ? "Creating account..." : "Create account"}
                            </PillButtonUI>
                        </div>
                    </form>
                </div>
                {alreadySetUp && (
                    <div className="text-center text-sm text-gray-500">
                        <Link
                            href="/login"
                            className="font-medium transition-colors hover:text-gray-950"
                        >
                            Log in
                        </Link>
                    </div>
                )}
            </div>
            <WarningPopup
                open={!!error}
                onClose={() => setError(null)}
                title={error?.title}
                message={error?.message}
                actions={
                    error?.supportable ? (
                        <a
                            href={supportMailtoFor(error, "Failed to set up Mike.")}
                            className={noticeActionClassName()}
                        >
                            Contact support
                        </a>
                    ) : undefined
                }
            />
        </div>
    );
}
