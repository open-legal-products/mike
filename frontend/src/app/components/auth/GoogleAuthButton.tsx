"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { GoogleIconUI } from "@/shared/ui/GoogleIconUI";
import { PillButton } from "@/app/components/ui/pill-button";
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
    const t = useTranslations("auth.google");

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
                    : t("erroContinuar"),
            );
            setLoading(false);
            onLoadingChange?.(false);
        }
    };

    return (
        <PillButton
            type="button"
            tone="white"
            size="normal"
            className="w-full"
            disabled={disabled || loading}
            loading={loading}
            onClick={() => void handleGoogleAuth()}
        >
            <GoogleIconUI className="h-4 w-4" />
            {loading ? t("botaoRedirecionando") : t("botaoContinuar")}
        </PillButton>
    );
}
