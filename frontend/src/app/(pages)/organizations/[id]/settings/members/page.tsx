"use client";

import { useSearchParams } from "next/navigation";
import { OrganizationMembers } from "@/app/components/organizations/OrganizationMembers";
import { useOrganizationSettings } from "@/app/components/organizations/OrganizationSettingsShell";

export default function OrganizationMembersSettingsPage() {
  const { orgId, reload } = useOrganizationSettings();
  // `?view=departed` opens the Departed view, for the links that lead to it.
  const departed = useSearchParams().get("view") === "departed";
  return (
    <OrganizationMembers
      orgId={orgId}
      onViewerRoleChanged={() => void reload()}
      initialTab={departed ? "departed" : "all"}
    />
  );
}
