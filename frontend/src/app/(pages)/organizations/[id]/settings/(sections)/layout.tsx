"use client";

import type { ReactNode } from "react";
import { OrganizationSettingsFrame } from "@/app/components/organizations/OrganizationSettingsShell";

export default function OrganizationSettingsSectionsLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <OrganizationSettingsFrame>{children}</OrganizationSettingsFrame>;
}
