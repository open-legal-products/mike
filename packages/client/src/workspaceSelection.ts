// Which workspace — the caller's personal content or one of their
// organizations — the lists are showing, as rules with no framework in them.
//
// The web app (WorkspaceContext) and the Word add-in both hold an active
// workspace. The rules for remembering it, falling back when an organization
// is gone, and switching to one just joined live here once, so the two
// clients cannot drift apart. The choice is a filter on what the caller can
// already open; it never grants access, and the server re-checks membership
// on every request (backend/src/lib/workspace.ts).

/** The workspace id of the caller's own, non-organization content. */
export const PERSONAL_WORKSPACE = "personal";
export const PERSONAL_WORKSPACE_LABEL = "Personal";

/** Kept byte-for-byte: existing web users keep their remembered workspace. */
export const WORKSPACE_STORAGE_PREFIX = "mike.activeWorkspace.";

/** The least an organization must carry to be offered as a workspace. */
export interface WorkspaceOrg {
    id: string;
    name: string;
}

/**
 * Where the selection is remembered. `window.localStorage` fits as is, and so
 * does `OfficeRuntime.storage` in the Word add-in, whose methods return
 * promises. Either may throw or reject (private windows, blocked site data):
 * remembering is a convenience and every reader here survives without it.
 */
export interface WorkspaceStorage {
    getItem(key: string): string | null | Promise<string | null>;
    setItem(key: string, value: string): void | Promise<void>;
}

/** A storage that answers at once, so the first render already knows. */
export interface SyncWorkspaceStorage extends WorkspaceStorage {
    getItem(key: string): string | null;
}

export function workspaceStorageKey(userId: string): string {
    return WORKSPACE_STORAGE_PREFIX + userId;
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as PromiseLike<T>).then === "function"
    );
}

/**
 * The remembered workspace when `storage` answers synchronously, or
 * `undefined` when it can only answer later (read it with
 * `readStoredWorkspace`). No account, nothing stored, or a storage that
 * throws all mean Personal.
 */
export function readStoredWorkspaceNow(
    storage: WorkspaceStorage,
    userId: string | null | undefined,
): string | undefined {
    if (!userId) return PERSONAL_WORKSPACE;
    try {
        const value = storage.getItem(workspaceStorageKey(userId));
        if (isPromiseLike<string | null>(value)) {
            // Asked only to learn that the answer is not ready; the caller
            // reads again with `readStoredWorkspace`.
            Promise.resolve(value).catch(() => {});
            return undefined;
        }
        return value || PERSONAL_WORKSPACE;
    } catch {
        return PERSONAL_WORKSPACE;
    }
}

/** The remembered workspace from any storage. Never rejects. */
export async function readStoredWorkspace(
    storage: WorkspaceStorage,
    userId: string | null | undefined,
): Promise<string> {
    if (!userId) return PERSONAL_WORKSPACE;
    try {
        return (
            (await storage.getItem(workspaceStorageKey(userId))) ||
            PERSONAL_WORKSPACE
        );
    } catch {
        return PERSONAL_WORKSPACE;
    }
}

/**
 * Remembers `workspaceId` for this account. A synchronous storage is written
 * before this returns. Never rejects: a choice not remembered across reloads
 * is all that is lost.
 */
export async function storeWorkspace(
    storage: WorkspaceStorage,
    userId: string | null | undefined,
    workspaceId: string,
): Promise<void> {
    if (!userId) return;
    try {
        await storage.setItem(workspaceStorageKey(userId), workspaceId);
    } catch {
        // Not remembered across reloads; nothing else depends on it.
    }
}

/**
 * The workspace in effect for a remembered selection.
 *
 * - `organizations` is `null` while the list has not loaded (or never could
 *   be read): the selection stands, since a failed read is not evidence that
 *   the caller left their organization.
 * - Once loaded, an organization the caller no longer belongs to falls back
 *   to Personal rather than leaving every list empty.
 */
export function resolveWorkspace<T extends { id: string }>(
    selectedWorkspaceId: string,
    organizations: readonly T[] | null,
): { workspaceId: string; activeOrganization: T | null } {
    if (selectedWorkspaceId === PERSONAL_WORKSPACE)
        return { workspaceId: PERSONAL_WORKSPACE, activeOrganization: null };
    const activeOrganization =
        organizations?.find((org) => org.id === selectedWorkspaceId) ?? null;
    return {
        workspaceId:
            organizations !== null && !activeOrganization
                ? PERSONAL_WORKSPACE
                : selectedWorkspaceId,
        activeOrganization,
    };
}

/** Personal, or an organization already in the loaded list. */
export function isKnownWorkspace(
    workspaceId: string,
    organizations: readonly { id: string }[] | null,
): boolean {
    return (
        workspaceId === PERSONAL_WORKSPACE ||
        (organizations ?? []).some((org) => org.id === workspaceId)
    );
}

export interface WorkspaceSwitchHandlers<T> {
    /** Make `workspaceId` the selection. */
    select(workspaceId: string): void;
    /** The organizations were read again to check an unknown id. */
    organizationsLoaded(organizations: T[]): void;
}

/**
 * Asks to switch to `next`.
 *
 * A known workspace is selected at once, before this returns. An unknown one
 * may be an organization the person has just created or joined, offered
 * before the list here was read again — ignoring that click made the button
 * look dead. So the list is read once (`listOrgs`; omit it when there is no
 * account to read for), and the switch happens only if `next` really is one
 * of theirs. A stranger's id, or a failed read, switches nothing.
 */
export async function requestWorkspaceSwitch<T extends { id: string }>(
    next: string,
    organizations: readonly T[] | null,
    listOrgs: (() => Promise<T[]>) | undefined,
    handlers: WorkspaceSwitchHandlers<T>,
): Promise<void> {
    if (isKnownWorkspace(next, organizations)) {
        handlers.select(next);
        return;
    }
    if (!listOrgs) return;
    let fresh: T[];
    try {
        fresh = await listOrgs();
    } catch {
        // Unknown stays unknown: nothing is switched.
        return;
    }
    handlers.organizationsLoaded(fresh);
    if (fresh.some((org) => org.id === next)) handlers.select(next);
}

/**
 * The `org_id` for something made in `workspace`: the organization's id, or
 * `undefined` in Personal and where no workspace is known.
 */
export function workspaceOrgId(
    workspace: string | null | undefined,
): string | undefined {
    return workspace && workspace !== PERSONAL_WORKSPACE ? workspace : undefined;
}

/**
 * Who owns ephemeral UI state (drafts, open pickers, cached lists): one
 * account in one workspace. State keyed by this is dropped, never carried
 * across, when either changes. No workspace means Personal.
 */
export function workspaceIdentityKey(
    accountId: string | null | undefined,
    workspace: string | null | undefined,
): string {
    return JSON.stringify([
        accountId ?? null,
        workspace ?? PERSONAL_WORKSPACE,
    ]);
}

/**
 * The rows of a workspace menu: Personal first, then each organization.
 * `null` when there is nothing to choose between — no organizations, or the
 * list has not loaded.
 */
export function workspaceMenuOptions(
    organizations: readonly WorkspaceOrg[] | null,
): WorkspaceOrg[] | null {
    if (!organizations || organizations.length === 0) return null;
    return [
        { id: PERSONAL_WORKSPACE, name: PERSONAL_WORKSPACE_LABEL },
        ...organizations.map((org) => ({ id: org.id, name: org.name })),
    ];
}

/** The display name of `workspaceId`, or "" when it is not in the list. */
export function workspaceName(
    workspaceId: string,
    organizations: readonly WorkspaceOrg[] | null,
): string {
    if (workspaceId === PERSONAL_WORKSPACE) return PERSONAL_WORKSPACE_LABEL;
    return organizations?.find((org) => org.id === workspaceId)?.name ?? "";
}
