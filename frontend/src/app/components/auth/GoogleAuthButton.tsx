"use client";

import { useState } from "react";
import { GoogleIconUI } from "@/shared/ui/GoogleIconUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { startGoogleOAuth } from "@/app/lib/authApi";

interface GoogleAuthButtonProps {
    onError: (message: string) => void;
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
        onError("");

        try {
            const { url } = await startGoogleOAuth("/onboarding/profile");
            window.location.assign(url);
        } catch (error: unknown) {
            onError(
                error instanceof Error
                    ? error.message
                    : "Unable to continue with Google",
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
