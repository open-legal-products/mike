"use client";

import { use, type ReactNode } from "react";
import { OrganizationSettingsProvider } from "@/app/components/organizations/OrganizationSettingsShell";

// Every page under an organization's settings shares the organization this
// loads. The sectioned frame is one level down, in (sections): the Members
// page is a full table page and sits outside it.
export default function OrganizationSettingsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <OrganizationSettingsProvider orgId={id}>
      {children}
    </OrganizationSettingsProvider>
  );
}
