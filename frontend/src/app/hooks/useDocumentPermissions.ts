"use client";

import { useEffect, useRef, useState } from "react";
import { getDocument } from "@/app/lib/mikeApi";

export type DocumentPermissions = { canEdit: boolean; canDelete: boolean };
type Permissions = DocumentPermissions;
const READ_ONLY: Permissions = { canEdit: false, canDelete: false };

/** Document rights are independent of the chat or project containing the viewer. */
export function useDocumentPermissions(documentIds: string[], enabled: boolean) {
    const key = JSON.stringify([...new Set(documentIds)].sort());
    const [cache, setCache] = useState<{ enabled: boolean; rights: Record<string, Permissions> }>({ enabled, rights: {} });
    // Reset synchronously when access changes, before children can observe a
    // previous session's permissions. Tab changes leave this cache intact.
    if (cache.enabled !== enabled) setCache({ enabled, rights: {} });
    const session = useRef({ active: false, requested: new Set<string>() });
    useEffect(() => {
        const current = { active: enabled, requested: new Set<string>() };
        session.current = current;
        return () => { current.active = false; };
    }, [enabled]);
    useEffect(() => {
        const current = session.current;
        if (!current.active) return;
        // Tab changes must not revoke already-resolved rights or cancel requests
        // for documents that are still open. Each request belongs to the access
        // session, which is invalidated on disable/unmount (including StrictMode).
        for (const id of JSON.parse(key) as string[]) {
            if (current.requested.has(id)) continue;
            current.requested.add(id);
            void Promise.resolve().then(() => getDocument(id)).then((document): Permissions => ({
                canEdit: document.can_edit === true,
                canDelete: document.can_delete === true,
            })).catch(() => READ_ONLY).then((permissions) => {
                if (current.active) setCache((previous) => ({ ...previous, rights: { ...previous.rights, [id]: permissions } }));
            });
        }
    }, [key, enabled]);
    return (id: string): Permissions => enabled && cache.enabled === enabled ? cache.rights[id] ?? READ_ONLY : READ_ONLY;
}
