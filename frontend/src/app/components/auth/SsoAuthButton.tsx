"use client";

import { Globe } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { PillButton } from "@/app/components/ui/pill-button";

interface SsoAuthButtonProps {
    disabled?: boolean;
}

export function SsoAuthButton({ disabled = false }: SsoAuthButtonProps) {
    const t = useTranslations("auth.sso");
    const router = useRouter();

    return (
        <PillButton
            type="button"
            tone="white"
            size="normal"
            className="w-full"
            disabled={disabled}
            onClick={() => router.push("/login/sso")}
        >
            <Globe aria-hidden="true" className="h-4 w-4" />
            {t("botaoContinuarSso")}
        </PillButton>
    );
}
