"use client";

import { useEffect, useState } from "react";
import { listMyOrgInvitations } from "@/app/lib/mikeApi";

const INVITATIONS_CHANGED_EVENT = "mike:organization-invitations-changed";

export function notifyOrganizationInvitationsChanged() {
    window.dispatchEvent(new Event(INVITATIONS_CHANGED_EVENT));
}

/** A background count for settings navigation; the invitations page owns errors. */
export function useOrganizationInvitationCount(userId: string | undefined) {
    const [result, setResult] = useState<{ userId: string; count: number } | null>(null);

    useEffect(() => {
        if (!userId) return;
        let disposed = false;
        let requestId = 0;

        const refresh = async () => {
            const currentRequest = ++requestId;
            try {
                const invitations = await listMyOrgInvitations();
                if (!disposed && currentRequest === requestId) {
                    setResult({ userId, count: invitations.length });
                }
            } catch {
                // Keep the last known count on a transient background failure.
            }
        };
        const refreshWhenVisible = () => {
            if (document.visibilityState !== "hidden") void refresh();
        };

        void refresh();
        window.addEventListener("focus", refreshWhenVisible);
        document.addEventListener("visibilitychange", refreshWhenVisible);
        window.addEventListener(INVITATIONS_CHANGED_EVENT, refreshWhenVisible);
        return () => {
            disposed = true;
            window.removeEventListener("focus", refreshWhenVisible);
            document.removeEventListener("visibilitychange", refreshWhenVisible);
            window.removeEventListener(INVITATIONS_CHANGED_EVENT, refreshWhenVisible);
        };
    }, [userId]);

    return result?.userId === userId ? result?.count ?? 0 : 0;
}
