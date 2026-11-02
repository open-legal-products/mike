"use client";

import type { ReactNode } from "react";
import { PlaybooksWorkspaceLayout } from "@/app/components/playbooks/PlaybooksWorkspace";

/**
 * The list and each playbook's page share one workspace, which reads the open
 * playbook from the URL. The pages themselves render nothing.
 */
export default function PlaybooksLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PlaybooksWorkspaceLayout />
      {children}
    </>
  );
}
