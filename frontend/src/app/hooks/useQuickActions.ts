"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
    createQuickAction,
    listQuickActions,
    updateQuickAction,
} from "@/app/lib/mikeApi";
import { useWorkspaceIdentity } from "@/app/hooks/useWorkspaceIdentity";
import { useDocumentWorkspace } from "@/app/contexts/WorkspaceContext";
import type { QuickAction } from "@/app/components/shared/types";

const LEGACY_VISIBLE_KEY = "mike.quickActions.visible";
const MIGRATED_KEY = "mike.quickActions.databaseMigrated";

async function migrateLegacyVisibility(
    actions: QuickAction[],
): Promise<{ actions: QuickAction[]; complete: boolean }> {
    if (window.localStorage.getItem(MIGRATED_KEY)) {
        return { actions, complete: true };
    }
    try {
        const legacy = JSON.parse(
            window.localStorage.getItem(LEGACY_VISIBLE_KEY) ?? "null",
        ) as Record<string, unknown> | null;
        const keyByTitle: Record<string, string> = {
            proofread: "proofread",
            "compare documents": "compareDocuments",
            "extract key terms": "extractKeyTerms",
            "draft from template": "draftFromTemplate",
        };
        if (legacy) {
            const migrations = await Promise.allSettled(
                actions.map((action) => {
                    const legacyActionKey =
                        keyByTitle[action.workflow.title.toLowerCase()];
                    const enabled = legacyActionKey
                        ? legacy[legacyActionKey]
                        : undefined;
                    return typeof enabled === "boolean" &&
                        enabled !== action.enabled
                        ? updateQuickAction(action.id, { enabled })
                        : action;
                }),
            );
            const resolved = migrations.map((result, index) =>
                result.status === "fulfilled" ? result.value : actions[index],
            );
            // Only mark the one-shot migration complete when every update
            // landed; otherwise a transient API failure would permanently
            // discard the user's legacy preferences. A partial batch retries
            // on the next load — updates are idempotent.
            if (migrations.some((result) => result.status === "rejected")) {
                return { actions: resolved, complete: false };
            }
            actions = resolved;
        }
        window.localStorage.setItem(MIGRATED_KEY, "1");
    } catch {
        // Invalid legacy state is ignored; database defaults win.
    }
    return { actions, complete: true };
}

/**
 * The caller's assistant quick actions. Loads once `enabled` first turns
 * true, so a surface that only offers editing them does not fetch up front.
 */
export function useQuickActions(enabled = true) {
    const identity = useWorkspaceIdentity();
    const workspace = useDocumentWorkspace() ?? "personal";
    const currentIdentity = useRef<string | null>(identity);
    useLayoutEffect(() => {
        currentIdentity.current = identity;
        return () => { currentIdentity.current = null; };
    }, [identity]);
    const [state, setState] = useState<{
        identity: string;
        actions: QuickAction[];
    }>({ identity, actions: [] });
    const quickActions = state.identity === identity ? state.actions : [];
    const setQuickActions = useCallback((update: QuickAction[] | ((actions: QuickAction[]) => QuickAction[])) => {
        if (currentIdentity.current !== identity) return;
        setState(current => ({
            identity,
            actions: typeof update === "function"
                ? update(current.identity === identity ? current.actions : [])
                : update,
        }));
    }, [identity]);
    const [requested, setRequested] = useState(enabled);
    if (enabled && !requested) setRequested(true);

    useEffect(() => {
        if (!requested) return;
        let cancelled = false;
        listQuickActions("app", workspace)
            .then(actions => {
                if (cancelled || currentIdentity.current !== identity) return { actions: [], complete: false };
                return workspace === "personal" ? migrateLegacyVisibility(actions) : { actions, complete: true };
            })
            .then(({ actions }) => {
                if (!cancelled) setQuickActions(actions);
            })
            .catch(() => {
                if (!cancelled) setQuickActions([]);
            });
        return () => {
            cancelled = true;
        };
    }, [requested, identity, workspace, setQuickActions]);

    const saveQuickAction = useCallback(async (action: QuickAction) => {
        const updated = await updateQuickAction(action.id, {
            workflow_id: action.workflow_id,
            name: action.name,
            prompt: action.prompt,
            document_upload: action.document_upload,
            enabled: action.enabled,
        });
        setQuickActions((current) =>
            current.map((item) => (item.id === updated.id ? updated : item)),
        );
    }, [setQuickActions]);

    const addQuickAction = useCallback(
        async (input: {
            workflowId: string;
            name: string;
            prompt: string;
            documentUpload: boolean;
        }) => {
            const created = await createQuickAction({
                workflow_id: input.workflowId,
                name: input.name,
                prompt: input.prompt,
                document_upload: input.documentUpload,
                surface: "app",
                enabled: true,
                sort_order: quickActions.length,
            });
            setQuickActions((current) => [...current, created]);
        },
        [quickActions.length, setQuickActions],
    );

    return { quickActions, saveQuickAction, addQuickAction };
}
