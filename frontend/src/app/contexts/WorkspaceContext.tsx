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
import { useWorkspaceSelection } from "@/shared/hooks/useWorkspaceSelection";
import {
    PERSONAL_WORKSPACE,
    storeWorkspace as storeWorkspaceIn,
    workspaceOrgId,
    type SyncWorkspaceStorage,
} from "@/shared/lib/workspaceSelection";

// The rules (remembering, falling back, switching) are shared with the Word
// add-in; re-exported so the app keeps importing them from here.
export {
    PERSONAL_WORKSPACE,
    PERSONAL_WORKSPACE_LABEL,
} from "@/shared/lib/workspaceSelection";

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

// A convenience remembered per account and per browser. Even reaching
// `window.localStorage` can throw (private windows, blocked site data), so it
// is looked up inside each call, where the shared readers catch it.
const browserStorage: SyncWorkspaceStorage = {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
};

/** Also used during onboarding, before the app's WorkspaceProvider mounts. */
export function storeWorkspace(userId: string | undefined, workspaceId: string) {
    void storeWorkspaceIn(browserStorage, userId, workspaceId);
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
    const { user } = useAuth();
    const userId = user?.id;
    const {
        workspaceId,
        organizations,
        activeOrganization,
        setWorkspace,
        refreshOrganizations,
    } = useWorkspaceSelection<Org>({
        userId,
        listOrgs,
        storage: browserStorage,
    });

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
    return workspaceOrgId(useContext(WorkspaceContext).workspaceId);
}
