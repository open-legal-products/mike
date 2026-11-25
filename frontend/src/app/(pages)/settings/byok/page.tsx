"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ManagedByOrganization } from "@/app/components/settings/ManagedByOrganization";
import { PersonalProviderKeys } from "@/app/components/settings/PersonalProviderKeys";
import {
    providerKeysHref,
    useWorkspaceSettingsScope,
} from "@/app/hooks/useWorkspaceSettingsScope";
import { WorkspaceScopePending } from "@/app/components/settings/WorkspaceScopePending";

/**
 * Settings > API Keys: the caller's own keys, for personal work.
 * Settings lists it only in Personal. An organization's keys are managed only
 * in its own settings, by its owners and admins, so one who follows a link
 * here in its workspace is sent there; a member is told who manages them.
 */
export default function ByokPage() {
    const scope = useWorkspaceSettingsScope();
    const router = useRouter();
    const organizationHref =
        scope.kind === "organization" ? providerKeysHref(scope) : null;

    useEffect(() => {
        if (organizationHref) router.replace(organizationHref);
    }, [organizationHref, router]);

    if (scope.kind === "personal") return <PersonalProviderKeys />;
    if (scope.kind === "managed")
        return (
            <ManagedByOrganization
                subject="Model provider keys"
                orgName={scope.orgName}
            />
        );
    return <WorkspaceScopePending unavailable={scope.kind === "unavailable"} />;
}
