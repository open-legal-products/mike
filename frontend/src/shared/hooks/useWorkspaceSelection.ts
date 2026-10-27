// The active workspace as React state, for both clients: the web app's
// WorkspaceProvider and the Word add-in's provider are thin wrappers around
// this hook. The rules themselves are in ../lib/workspaceSelection.

import { useCallback, useEffect, useState } from "react";
import {
    PERSONAL_WORKSPACE,
    readStoredWorkspace,
    readStoredWorkspaceNow,
    requestWorkspaceSwitch,
    resolveWorkspace,
    storeWorkspace,
    type WorkspaceStorage,
} from "../lib/workspaceSelection";

export interface UseWorkspaceSelectionOptions<T> {
    /** The signed-in account; `undefined` while signed out. */
    userId: string | undefined;
    /**
     * Reads the caller's organizations. Must be stable across renders (a
     * module-level function), or the list is re-read on every render.
     */
    listOrgs: () => Promise<T[]>;
    /** Where the choice is remembered. Must be stable across renders. */
    storage: WorkspaceStorage;
}

export interface WorkspaceSelection<T> {
    /** "personal" or an organization id: the workspace in effect. */
    workspaceId: string;
    /**
     * Whether the remembered choice has been read. Always true for a storage
     * that answers synchronously (the web app's localStorage); with an
     * asynchronous one (the add-in's OfficeRuntime.storage) `workspaceId` is
     * Personal until then, so a client should not list anything before.
     */
    ready: boolean;
    /** The organizations the caller belongs to; `null` until first loaded. */
    organizations: T[] | null;
    /** The active organization, or `null` in the personal workspace. */
    activeOrganization: T | null;
    setWorkspace: (workspaceId: string) => void;
    refreshOrganizations: () => Promise<void>;
}

interface SelectionState<T> {
    userId: string | undefined;
    /** The remembered choice, before falling back for a lost membership. */
    workspaceId: string;
    ready: boolean;
    organizations: T[] | null;
}

function initialState<T>(
    storage: WorkspaceStorage,
    userId: string | undefined,
): SelectionState<T> {
    const stored = readStoredWorkspaceNow(storage, userId);
    return {
        userId,
        workspaceId: stored ?? PERSONAL_WORKSPACE,
        ready: stored !== undefined,
        organizations: null,
    };
}

export function useWorkspaceSelection<T extends { id: string }>({
    userId,
    listOrgs,
    storage,
}: UseWorkspaceSelectionOptions<T>): WorkspaceSelection<T> {
    const [state, setState] = useState<SelectionState<T>>(() =>
        initialState(storage, userId),
    );

    // A different account signed in under the same mounted provider: its
    // remembered workspace applies, not the previous account's.
    if (state.userId !== userId) setState(initialState(storage, userId));

    // An asynchronous storage answers after the first render. A choice made
    // in the meantime wins over the remembered one.
    useEffect(() => {
        if (state.ready) return;
        let cancelled = false;
        void readStoredWorkspace(storage, userId).then((stored) => {
            if (cancelled) return;
            setState((current) =>
                current.userId !== userId || current.ready
                    ? current
                    : {
                          ...current,
                          ready: true,
                          workspaceId: resolveWorkspace(
                              stored,
                              current.organizations,
                          ).workspaceId,
                      },
            );
        });
        return () => {
            cancelled = true;
        };
    }, [state.ready, storage, userId]);

    const refreshOrganizations = useCallback(async () => {
        if (!userId) return;
        let next: T[];
        try {
            next = await listOrgs();
        } catch {
            // Keep whatever was known. A failed read is not evidence that the
            // caller left their organization, so the selection stands.
            return;
        }
        // The remembered workspace is only as good as the membership behind
        // it. One the caller no longer belongs to falls back to Personal
        // rather than leaving every list empty — and stays there, so being
        // invited back later does not silently move them again.
        setState((current) =>
            current.userId !== userId
                ? current
                : {
                      ...current,
                      organizations: next,
                      workspaceId: resolveWorkspace(current.workspaceId, next)
                          .workspaceId,
                  },
        );
    }, [listOrgs, userId]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- start the organizations request once the account is known
        void refreshOrganizations();
    }, [refreshOrganizations]);

    // Membership changes somewhere else entirely — an owner's roster page, an
    // invitation accepted in another tab — so the list is re-read when the
    // person comes back to this one.
    useEffect(() => {
        const onVisible = () => {
            if (document.visibilityState === "visible")
                void refreshOrganizations();
        };
        document.addEventListener("visibilitychange", onVisible);
        return () =>
            document.removeEventListener("visibilitychange", onVisible);
    }, [refreshOrganizations]);

    // Derived as well as reconciled above, so the very render that learns
    // the organization is gone already asks for Personal.
    const { workspaceId, activeOrganization } = resolveWorkspace(
        state.workspaceId,
        state.organizations,
    );
    const { ready, organizations } = state;

    useEffect(() => {
        if (ready) void storeWorkspace(storage, userId, workspaceId);
    }, [ready, storage, userId, workspaceId]);

    const setWorkspace = useCallback(
        (next: string) => {
            void requestWorkspaceSwitch(
                next,
                organizations,
                userId ? listOrgs : undefined,
                {
                    select: (workspaceId) =>
                        setState((current) =>
                            current.userId === userId
                                ? { ...current, workspaceId, ready: true }
                                : current,
                        ),
                    organizationsLoaded: (fresh) =>
                        setState((current) =>
                            current.userId === userId
                                ? { ...current, organizations: fresh }
                                : current,
                        ),
                },
            );
        },
        [listOrgs, organizations, userId],
    );

    return {
        workspaceId,
        ready,
        organizations,
        activeOrganization,
        setWorkspace,
        refreshOrganizations,
    };
}
