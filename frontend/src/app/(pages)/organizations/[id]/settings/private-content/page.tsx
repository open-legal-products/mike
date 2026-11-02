"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useOrganizationSettings } from "@/app/components/organizations/OrganizationSettingsShell";

export default function OrganizationPrivateContentPage() {
  const { orgId } = useOrganizationSettings();
  const router = useRouter();
  useEffect(() => {
    router.replace(
      `/organizations/${encodeURIComponent(orgId)}/settings/audit`,
    );
  }, [orgId, router]);
  return null;
}
