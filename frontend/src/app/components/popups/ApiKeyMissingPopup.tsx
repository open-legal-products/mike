"use client";

import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import { providerLabel, type ModelProvider } from "@/app/lib/modelAvailability";
import { WarningPopup } from "../popups/WarningPopup";

interface Props {
    open: boolean;
    onClose: () => void;
    provider: ModelProvider | null;
    /** Optional override for the body sentence. */
    message?: string;
}

export function ApiKeyMissingPopup({ open, onClose, provider, message }: Props) {
    const router = useRouter();
    const t = useTranslations("modals.apiKeyMissing");
    if (!open) return null;

    const providerName = provider ? providerLabel(provider) : t("provedorPadrao");
    const body = message ?? t("corpo", { providerName });

    const handleGoToSettings = () => {
        onClose();
        router.push("/settings/byok");
    };

    return (
        <WarningPopup
            open={open}
            onClose={onClose}
            title={t("titulo")}
            message={body}
            icon={
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
            }
            primaryAction={{
                label: t("irConfiguracoes"),
                onClick: handleGoToSettings,
            }}
        />
    );
}
