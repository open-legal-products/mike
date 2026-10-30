"use client";

// The active workspace: which of the caller's organizations — or their
// personal content — the lists are currently showing.
//
// A person may belong to several organizations and also holds personal
// content. The lists show one of those at a time, so it is always clear whose
// work is on screen. The choice is a filter on what the caller can already
// open; it never grants access, and the server re-checks membership on every
// request (backend/src/lib/workspace.ts).

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from "react";
import { useAuth } from "@/app/contexts/AuthContext";
import {
    getOrgApiKeys,
    listOrgs,
    type Org,
    type OrgApiKeySettings,
} from "@/app/lib/mikeApi";

export const PERSONAL_WORKSPACE = "personal";
export const PERSONAL_WORKSPACE_LABEL = "Personal";

const STORAGE_PREFIX = "mike.activeWorkspace.";

interface WorkspaceContextValue {
    /** Account that owns ephemeral state in this workspace. */
    accountId?: string;
    /**
     * "personal", an organization id, or `null` outside a WorkspaceProvider.
     * `null` means "do not narrow": surfaces that render without the app
     * shell keep listing everything, as they did before workspaces.
     */
    workspaceId: string | null;
    /** The organizations the caller belongs to; `null` until first loaded. */
    organizations: Org[] | null;
    /** The active organization, or `null` in the personal workspace. */
    activeOrganization: Org | null;
    /**
     * The active organization's model provider keys as the caller may use
     * them, or `null` — in the personal workspace, until first loaded, and
     * when the read failed. Work in an organization runs on these rather
     * than on the caller's own keys.
     */
    orgApiKeys: OrgApiKeySettings | null;
    setWorkspace: (workspaceId: string) => void;
    refreshOrganizations: () => Promise<void>;
    /** Re-read `orgApiKeys`, after they were changed in settings. */
    refreshOrgApiKeys: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue>({
    workspaceId: null,
    organizations: null,
    activeOrganization: null,
    orgApiKeys: null,
    setWorkspace: () => {},
    refreshOrganizations: async () => {},
    refreshOrgApiKeys: async () => {},
});

// A convenience remembered per account and per browser: it can come back
// empty or throw (private windows, blocked site data), and the app must work
// the same without it. Exported for onboarding, which runs outside the
// provider and wants to know which organization the person just joined.
export function readStoredWorkspace(userId: string | undefined): string {
    if (!userId) return PERSONAL_WORKSPACE;
    try {
        return (
            window.localStorage.getItem(STORAGE_PREFIX + userId) ||
            PERSONAL_WORKSPACE
        );
    } catch {
        return PERSONAL_WORKSPACE;
    }
}

/** Also used during onboarding, before the app's WorkspaceProvider mounts. */
export function storeWorkspace(userId: string | undefined, workspaceId: string) {
    if (!userId) return;
    try {
        window.localStorage.setItem(STORAGE_PREFIX + userId, workspaceId);
    } catch {
        // Not remembered across reloads; nothing else depends on it.
    }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
    const { user } = useAuth();
    const userId = user?.id;
    const [selection, setSelection] = useState(() => ({
        userId,
        workspaceId: readStoredWorkspace(userId),
    }));
    const [organizations, setOrganizations] = useState<Org[] | null>(null);

    // A different account signed in under the same mounted provider: its
    // remembered workspace applies, not the previous account's.
    if (selection.userId !== userId) {
        setSelection({ userId, workspaceId: readStoredWorkspace(userId) });
        setOrganizations(null);
    }
    const storedWorkspaceId = selection.workspaceId;

    const refreshOrganizations = useCallback(async () => {
        if (!userId) return;
        let next: Org[];
        try {
            next = await listOrgs();
        } catch {
            // Keep whatever was known. A failed read is not evidence that the
            // caller left their organization, so the selection stands.
            return;
        }
        setOrganizations(next);
        // The remembered workspace is only as good as the membership behind
        // it. One the caller no longer belongs to falls back to Personal
        // rather than leaving every list empty — and stays there, so being
        // invited back later does not silently move them again.
        setSelection((current) =>
            current.userId !== userId ||
            current.workspaceId === PERSONAL_WORKSPACE ||
            next.some((org) => org.id === current.workspaceId)
                ? current
                : { userId, workspaceId: PERSONAL_WORKSPACE },
        );
    }, [userId]);

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

    // Derived as well as reset above, so the very render that learns the
    // organization is gone already asks for Personal.
    const activeOrganization =
        storedWorkspaceId === PERSONAL_WORKSPACE
            ? null
            : (organizations?.find((org) => org.id === storedWorkspaceId) ??
              null);
    const workspaceId =
        storedWorkspaceId !== PERSONAL_WORKSPACE &&
        organizations !== null &&
        !activeOrganization
            ? PERSONAL_WORKSPACE
            : storedWorkspaceId;

    useEffect(() => {
        storeWorkspace(userId, workspaceId);
    }, [userId, workspaceId]);

    // Which providers the active organization can run. Held with the id it
    // was read for, so switching workspace never shows one organization's
    // answer under another's name while the new read is in flight.
    const [orgKeys, setOrgKeys] = useState<{
        orgId: string;
        settings: OrgApiKeySettings;
    } | null>(null);
    const activeOrgId = activeOrganization?.id ?? null;
    const refreshOrgApiKeys = useCallback(async () => {
        if (!activeOrgId) return;
        try {
            const settings = await getOrgApiKeys(activeOrgId);
            setOrgKeys({ orgId: activeOrgId, settings });
        } catch {
            // Unknown, not "nothing is set up": the pickers fail open and the
            // server still decides what a request may run on.
            setOrgKeys((current) =>
                current?.orgId === activeOrgId ? current : null,
            );
        }
    }, [activeOrgId]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- start the keys request once the active organization is known
        void refreshOrgApiKeys();
    }, [refreshOrgApiKeys]);

    const orgApiKeys =
        orgKeys && orgKeys.orgId === activeOrgId ? orgKeys.settings : null;

    const setWorkspace = useCallback(
        (next: string) => {
            const known =
                next === PERSONAL_WORKSPACE ||
                (organizations ?? []).some((org) => org.id === next);
            if (known) {
                setSelection({ userId, workspaceId: next });
                return;
            }
            // Not one this provider has heard of — yet. An organization the
            // person has just created or joined is offered to switch to
            // before the list here has been read again, and ignoring that
            // click made the button look dead. Ask once, then switch if it
            // really is theirs; a stranger's id still goes nowhere.
            if (!userId) return;
            void listOrgs()
                .then((orgs) => {
                    setOrganizations(orgs);
                    if (orgs.some((org) => org.id === next))
                        setSelection((current) =>
                            current.userId === userId
                                ? { userId, workspaceId: next }
                                : current,
                        );
                })
                .catch(() => {
                    // Unknown stays unknown: nothing is switched.
                });
        },
        [organizations, userId],
    );

    const value = useMemo(
        () => ({
            accountId: userId,
            workspaceId,
            organizations,
            activeOrganization,
            orgApiKeys,
            setWorkspace,
            refreshOrganizations,
            refreshOrgApiKeys,
        }),
        [
            userId,
            workspaceId,
            organizations,
            activeOrganization,
            orgApiKeys,
            setWorkspace,
            refreshOrganizations,
            refreshOrgApiKeys,
        ],
    );

    return (
        <WorkspaceContext.Provider value={value}>
            {children}
        </WorkspaceContext.Provider>
    );
}

export function useWorkspace(): WorkspaceContextValue {
    return useContext(WorkspaceContext);
}

/**
 * The `workspace` argument for a list request: the active workspace, or
 * `undefined` outside a provider so the request is not narrowed.
 */
export function useWorkspaceParam(): string | undefined {
    return useContext(WorkspaceContext).workspaceId ?? undefined;
}

// The workspace of the chat, review, project or workflow on screen, for the
// document pickers and uploads inside it. Undefined where nothing says.
const DocumentWorkspaceContext = createContext<string | undefined>(undefined);

/**
 * Says which workspace the item rendered inside belongs to: `orgId` is its
 * organization, null for a personal one, undefined while that is not known.
 *
 * Something is built from documents in its own workspace, and the server
 * refuses any other. The active workspace is usually the same one, but an
 * item can be opened from a link while another workspace is active, and its
 * pickers must still offer documents it can take.
 */
export function DocumentWorkspaceScope({
    orgId,
    children,
}: {
    orgId: string | null | undefined;
    children: ReactNode;
}) {
    const inherited = useContext(DocumentWorkspaceContext);
    const workspace =
        orgId === undefined ? inherited : (orgId ?? PERSONAL_WORKSPACE);
    return (
        <DocumentWorkspaceContext.Provider value={workspace}>
            {children}
        </DocumentWorkspaceContext.Provider>
    );
}

/**
 * The workspace whose documents are offered, and where an upload is filed:
 * that of the item on screen when a `DocumentWorkspaceScope` names it,
 * otherwise the active workspace.
 */
export function useDocumentWorkspace(): string | undefined {
    const scoped = useContext(DocumentWorkspaceContext);
    const active = useContext(WorkspaceContext).workspaceId ?? undefined;
    return scoped ?? active;
}

/**
 * The `org_id` for something started on its own, outside any project — a
 * chat, a tabular review: the organization whose workspace is active, or
 * `undefined` in Personal. What is started in an organization's workspace
 * belongs to that organization.
 *
 * Read from the workspace id rather than the loaded organization, so that
 * something started while the list of organizations is still loading is not
 * filed under Personal by accident. The server checks membership.
 */
export function useWorkspaceOrgId(): string | undefined {
    const { workspaceId } = useContext(WorkspaceContext);
    return workspaceId && workspaceId !== PERSONAL_WORKSPACE
        ? workspaceId
        : undefined;
}
