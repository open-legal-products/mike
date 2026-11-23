import {
    PERSONAL_WORKSPACE,
    useWorkspace,
} from "@/app/contexts/WorkspaceContext";
import { isOrgAdmin } from "@/app/lib/permissions";

/**
 * Whose Features, Model Preferences and provider keys Settings shows in the
 * active workspace, and whether the caller may change them.
 *
 *   personal      the caller's own, in Personal (and outside a workspace)
 *   organization  the organization's, which its owners and admins manage
 *   managed       the organization's, set for a member who cannot change
 *                 them; Settings does not list these pages for them
 *   loading       an organization's workspace before the organization has
 *                 loaded, when it is not yet known which of the two it is
 *
 * The server decides every change regardless.
 */
export type WorkspaceSettingsScope =
    | { kind: "personal" }
    | { kind: "organization"; orgId: string; orgName: string }
    | { kind: "managed"; orgName: string }
    | { kind: "loading" };

export function useWorkspaceSettingsScope(): WorkspaceSettingsScope {
    const { workspaceId, activeOrganization } = useWorkspace();
    if (workspaceId === null || workspaceId === PERSONAL_WORKSPACE)
        return { kind: "personal" };
    if (!activeOrganization) return { kind: "loading" };
    return isOrgAdmin(activeOrganization.role)
        ? {
              kind: "organization",
              orgId: activeOrganization.id,
              orgName: activeOrganization.name,
          }
        : { kind: "managed", orgName: activeOrganization.name };
}
