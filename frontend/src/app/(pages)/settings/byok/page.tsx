"use client";

import { OrganizationProviderKeys } from "@/app/components/organizations/OrganizationProviderKeys";
import { ManagedByOrganization } from "@/app/components/settings/ManagedByOrganization";
import { PersonalProviderKeys } from "@/app/components/settings/PersonalProviderKeys";
import { useWorkspaceSettingsScope } from "@/app/hooks/useWorkspaceSettingsScope";

/**
 * Settings > Bring Your Own Keys: the keys work in the active workspace runs
 * on. Personal work runs on the caller's own; work in an organization runs on
 * the organization's, which its owners and admins manage here as they can in
 * its settings.
 */
export default function ByokPage() {
    const scope = useWorkspaceSettingsScope();
    if (scope.kind === "loading") return null;
    if (scope.kind === "managed")
        return (
            <ManagedByOrganization
                subject="Model provider keys"
                orgName={scope.orgName}
            />
        );
    if (scope.kind === "organization")
        return (
            <OrganizationProviderKeys
                key={scope.orgId}
                orgId={scope.orgId}
                orgName={scope.orgName}
            />
        );
    return <PersonalProviderKeys />;
}
