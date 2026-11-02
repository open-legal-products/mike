"use client";

import { useEffect, useRef } from "react";
import {
    PERSONAL_WORKSPACE,
    PERSONAL_WORKSPACE_LABEL,
    useWorkspace,
} from "@/app/contexts/WorkspaceContext";
import { showToast } from "@/shared/lib/toastStore";

/** One notice for a switch, however many things on the page ask for it. */
export const WORKSPACE_SWITCH_TOAST_KEY = "workspace-switch";

/** Shorter than an ordinary notice: it only confirms what the sidebar shows. */
export const WORKSPACE_SWITCH_TOAST_MS = 2500;

/**
 * Says the active workspace has changed, to `name`. `reason` is for a switch
 * the person did not ask for themselves.
 */
export function notifyWorkspaceSwitched(name: string, reason?: string): void {
    showToast({
        tone: "info",
        title: `Switched to ${name}`,
        message: reason,
        durationMs: WORKSPACE_SWITCH_TOAST_MS,
        dedupeKey: WORKSPACE_SWITCH_TOAST_KEY,
    });
}

/**
 * Opening an item opens its workspace.
 *
 * The lists, the sidebar and whatever is started next all follow the active
 * workspace, so a project, chat, review or workflow reached from a link
 * while another workspace is active would sit under the wrong name. The page
 * showing the item says which workspace it belongs to, and the active one
 * changes to match, with a notice saying so.
 *
 * It happens once for each item opened. After that the workspace is the
 * person's to change, and the switcher takes them to the new workspace's
 * home rather than back here.
 *
 * `orgId` is the item's organization, null for a personal one, and undefined
 * while that is not known or does not apply (a built-in workflow belongs to
 * no workspace). Only an organization the person belongs to is switched to.
 */
export function useItemWorkspace(
    itemId: string | null | undefined,
    orgId: string | null | undefined,
): void {
    const { workspaceId, organizations, setWorkspace } = useWorkspace();
    const settledFor = useRef<string | null>(null);

    useEffect(() => {
        // `workspaceId` is null outside a WorkspaceProvider, where there is
        // nothing to switch between.
        if (!itemId || orgId === undefined || workspaceId === null) return;
        if (settledFor.current === itemId) return;
        const target = orgId ?? PERSONAL_WORKSPACE;
        if (target === workspaceId) {
            settledFor.current = itemId;
            return;
        }
        let name = PERSONAL_WORKSPACE_LABEL;
        if (orgId) {
            // Which organizations are theirs is not known yet: ask again
            // once it is.
            if (organizations === null) return;
            const org = organizations.find(
                (candidate) => candidate.id === orgId,
            );
            if (!org) {
                settledFor.current = itemId;
                return;
            }
            name = org.name;
        }
        settledFor.current = itemId;
        setWorkspace(target);
        notifyWorkspaceSwitched(
            name,
            "What you opened belongs to this workspace.",
        );
    }, [itemId, orgId, workspaceId, organizations, setWorkspace]);
}
