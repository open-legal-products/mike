"use client";

import { useDocumentWorkspace, useWorkspace } from "@/app/contexts/WorkspaceContext";

/** Ephemeral UI state belongs to one account and one content workspace. */
export function useWorkspaceIdentity(): string {
    const { accountId } = useWorkspace();
    const workspace = useDocumentWorkspace() ?? "personal";
    return JSON.stringify([accountId ?? null, workspace]);
}
