"use client";

import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import type { NoModelsReason } from "../assistant/ModelToggle";
import { WarningPopup } from "./WarningPopup";

export function NoModelsWarningPopup({
    reason,
    onClose,
}: {
    reason: NoModelsReason | null;
    onClose: () => void;
}) {
    if (!reason) return null;

    return <VisibleNoModelsWarning reason={reason} onClose={onClose} />;
}

function VisibleNoModelsWarning({
    reason,
    onClose,
}: {
    reason: NoModelsReason;
    onClose: () => void;
}) {
    const router = useRouter();
    const t = useTranslations("popups.semModelos");

    const routerModelsMissing = reason === "router-models";
    return (
        <WarningPopup
            open
            onClose={onClose}
            title={t("titulo")}
            message={
                routerModelsMissing
                    ? t("mensagemRoteador")
                    : t("mensagemSemChave")
            }
            icon={
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
            }
            primaryAction={{
                label: t("abrirByok"),
                onClick: () => {
                    onClose();
                    router.push(
                        routerModelsMissing
                            ? "/settings/byok#routers"
                            : "/settings/byok",
                    );
                },
            }}
        />
    );
}
