"use client";

import { useState } from "react";
import { GoogleIconUI } from "@/shared/ui/GoogleIconUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { startGoogleOAuth } from "@/app/lib/authApi";
import {
    describeError,
    type UserFacingError,
} from "@/app/lib/userFacingError";

const GOOGLE_ERROR_MESSAGES = {
    provider_disabled:
        "Google sign-in is turned off for this workspace. Use your email and password instead.",
    oauth_provider_not_supported:
        "Google sign-in is turned off for this workspace. Use your email and password instead.",
    over_request_rate_limit: "Too many attempts. Wait a moment and try again.",
} as const;

interface GoogleAuthButtonProps {
    /** Receives a classified failure, or `null` when the error is cleared. */
    onError: (error: UserFacingError | null) => void;
    disabled?: boolean;
    onLoadingChange?: (loading: boolean) => void;
}

export function GoogleAuthButton({
    onError,
    disabled = false,
    onLoadingChange,
}: GoogleAuthButtonProps) {
    const [loading, setLoading] = useState(false);

    const handleGoogleAuth = async () => {
        setLoading(true);
        onLoadingChange?.(true);
        onError(null);

        try {
            const { url } = await startGoogleOAuth("/onboarding/profile");
            window.location.assign(url);
        } catch (error: unknown) {
            // A provider error message ("invalid_client", a stack line) is
            // never shown; the caller renders the classified text instead.
            onError(
                describeError(error, {
                    action: "continue with Google",
                    codeMessages: GOOGLE_ERROR_MESSAGES,
                    fallback:
                        "Unable to continue with Google. Try again, or log in with your email and password.",
                }),
            );
            setLoading(false);
            onLoadingChange?.(false);
        }
    };

    return (
        <PillButtonUI
            type="button"
            tone="white"
            size="normal"
            className="w-full"
            disabled={disabled || loading}
            loading={loading}
            onClick={() => void handleGoogleAuth()}
        >
            <GoogleIconUI className="h-4 w-4" />
            {loading ? "Continuing…" : "Continue with Google"}
        </PillButtonUI>
    );
}
