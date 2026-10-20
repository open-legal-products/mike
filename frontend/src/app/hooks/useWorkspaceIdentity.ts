"use client";

import { useDocumentWorkspace, useWorkspace } from "@/app/contexts/WorkspaceContext";
import { workspaceIdentityKey } from "@/shared/lib/workspaceSelection";

/** Ephemeral UI state belongs to one account and one content workspace. */
export function useWorkspaceIdentity(): string {
    const { accountId } = useWorkspace();
    return workspaceIdentityKey(accountId, useDocumentWorkspace());
}
