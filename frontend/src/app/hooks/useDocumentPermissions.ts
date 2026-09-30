"use client";

import { useEffect, useState } from "react";
import { getDocument } from "@/app/lib/mikeApi";

type Permissions = { canEdit: boolean; canDelete: boolean };
const READ_ONLY: Permissions = { canEdit: false, canDelete: false };

/** Document rights are independent of the chat or project containing the viewer. */
export function useDocumentPermissions(documentIds: string[], enabled: boolean) {
    const key = JSON.stringify([...new Set(documentIds)].sort());
    const [result, setResult] = useState<{ key: string; rights: Record<string, Permissions> } | null>(null);
    useEffect(() => {
        if (!enabled) return;
        let active = true;
        const ids: string[] = JSON.parse(key);
        void Promise.all(ids.map(async (id) => {
            try {
                const document = await getDocument(id);
                return [id, { canEdit: document.can_edit === true, canDelete: document.can_delete === true }] as const;
            } catch {
                return [id, READ_ONLY] as const;
            }
        })).then((entries) => {
            if (active) setResult({ key, rights: Object.fromEntries(entries) });
        });
        return () => { active = false; };
    }, [key, enabled]);
    return (id: string): Permissions => enabled && result?.key === key
        ? result.rights[id] ?? READ_ONLY : READ_ONLY;
}
