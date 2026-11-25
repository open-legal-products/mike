import { isOrgAdmin, type OrgRole } from "@/app/lib/permissions";

/**
 * What an organization's own area is called for the caller: its owners and
 * admins run it from Organization Settings; a member opens its Organization
 * page. Before the caller's role is known it is the Organization.
 */
export function organizationAreaName(
    role: OrgRole | null | undefined,
): "Organization Settings" | "Organization" {
    return isOrgAdmin(role) ? "Organization Settings" : "Organization";
}
