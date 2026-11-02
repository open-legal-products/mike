"use client";

import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import { isOrgAdmin } from "@/app/lib/permissions";
import {
    NO_MODELS_MESSAGES,
    isOrganizationNoModelsReason,
    type NoModelsReason,
} from "@/shared/lib/modelCatalog";
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
    const { activeOrganization } = useWorkspace();
    // When the fix is the organization's to make, an owner or admin is sent
    // to its settings, where they can make it. A member cannot open that
    // page, so the warning tells them whom to ask and offers no button that
    // would lead nowhere. Otherwise it is the caller's own keys.
    const organizationFix =
        isOrganizationNoModelsReason(reason) && activeOrganization !== null;
    const settingsHref =
        organizationFix && isOrgAdmin(activeOrganization.role)
            ? `/organizations/${activeOrganization.id}/settings/providers`
            : null;

    return (
        <WarningPopup
            open
            onClose={onClose}
            title="No models available"
            message={NO_MODELS_MESSAGES[reason]}
            icon={
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
            }
            primaryAction={
                settingsHref
                    ? {
                          label: "Open Organization",
                          onClick: () => {
                              onClose();
                              router.push(settingsHref);
                          },
                      }
                    : organizationFix
                      ? undefined
                      : {
                            label: "Open Bring Your Own Keys",
                            onClick: () => {
                                onClose();
                                router.push("/settings/byok");
                            },
                        }
            }
        />
    );
}
