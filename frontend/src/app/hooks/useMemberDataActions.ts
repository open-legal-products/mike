import {
    PERSONAL_WORKSPACE,
    useWorkspace,
} from "@/app/contexts/WorkspaceContext";
import { isOrgOwner } from "@/app/lib/permissions";

export type MemberDataActions = {
    /** Settings > Privacy & Data may export this workspace's data. */
    canExport: boolean;
    /** Settings > Privacy & Data may delete it in bulk. */
    canDelete: boolean;
};

const ALL: MemberDataActions = { canExport: true, canDelete: true };
const NONE: MemberDataActions = { canExport: false, canDelete: false };

/**
 * What Settings > Privacy & Data may do in the active workspace. Everything
 * in Personal, and for an organization's owners; for its other members, what
 * the owners allow — nothing until the organization has loaded, so nothing is
 * offered and then withdrawn. The server decides each request regardless.
 */
export function useMemberDataActions(): MemberDataActions {
    const { workspaceId, activeOrganization } = useWorkspace();
    if (workspaceId === null || workspaceId === PERSONAL_WORKSPACE) return ALL;
    if (!activeOrganization) return NONE;
    if (isOrgOwner(activeOrganization.role)) return ALL;
    return {
        canExport: activeOrganization.allow_member_exports === true,
        canDelete: activeOrganization.allow_member_deletes === true,
    };
}
