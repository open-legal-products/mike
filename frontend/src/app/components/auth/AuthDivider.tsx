"use client";

import { useTranslations } from "next-intl";
import { AuthDividerUI } from "@/shared/ui/AuthDividerUI";

export function AuthDivider() {
    const t = useTranslations("auth.divider");
    return <AuthDividerUI label={t("ou")} />;
}
