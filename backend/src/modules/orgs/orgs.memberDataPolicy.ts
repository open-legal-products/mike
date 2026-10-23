// What an organization's members may do with their own work in it from
// Settings > Privacy & Data: export it, and delete it in bulk.
//
// Both are off until an owner allows them (organizations.allow_member_exports
// and allow_member_deletes). The firm's work is the firm's: whether it leaves
// in an export, or is erased wholesale, is its owners' call. Owners are never
// held back by either setting, and deleting one item at a time is unaffected.

import { recordAudit } from "../../lib/audit";
import { getOrgRole, isOrgOwner } from "../../lib/access";
import type { OrgResult } from "../../lib/orgs";
import type { Db } from "../../lib/supabase";

export type MemberDataAction = "export" | "delete";

export type OrgMemberDataPolicy = {
    allow_member_exports: boolean;
    allow_member_deletes: boolean;
};

const COLUMN: Record<MemberDataAction, keyof OrgMemberDataPolicy> = {
    export: "allow_member_exports",
    delete: "allow_member_deletes",
};

/**
 * Whether `userId` may export or bulk-delete their own work in `orgId`: always
 * for an owner, otherwise as the organization allows. False for someone who is
 * not a member. A read failure throws rather than answering either way.
 */
export async function memberDataActionAllowed(
    db: Db,
    userId: string,
    orgId: string,
    action: MemberDataAction,
): Promise<boolean> {
    const role = await getOrgRole(userId, orgId, db);
    if (!role) return false;
    if (isOrgOwner(role)) return true;
    const column = COLUMN[action];
    const { data, error } = await db
        .from("organizations")
        .select(column)
        .eq("id", orgId)
        .maybeSingle();
    if (error) throw new Error("Failed to read the organization's data policy");
    return (data as Partial<OrgMemberDataPolicy> | null)?.[column] === true;
}

/** Turn members' exports and bulk deletes on or off. Owners only. */
export async function setOrgMemberDataPolicy(
    db: Db,
    params: {
        actorId: string;
        actorEmail?: string | null;
        orgId: string;
        allowExports: unknown;
        allowDeletes: unknown;
    },
): Promise<OrgResult<{ policy: OrgMemberDataPolicy }>> {
    const role = await getOrgRole(params.actorId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };
    if (!isOrgOwner(role)) return { ok: false, kind: "owner_required" };
    if (
        typeof params.allowExports !== "boolean" ||
        typeof params.allowDeletes !== "boolean"
    )
        return {
            ok: false,
            kind: "validation",
            detail: "allow_member_exports and allow_member_deletes must be true or false",
        };

    const { data: before, error: readError } = await db
        .from("organizations")
        .select("allow_member_exports, allow_member_deletes")
        .eq("id", params.orgId)
        .maybeSingle();
    if (readError) return { ok: false, kind: "db_error", detail: readError.message };
    if (!before) return { ok: false, kind: "not_found" };

    const policy: OrgMemberDataPolicy = {
        allow_member_exports: params.allowExports,
        allow_member_deletes: params.allowDeletes,
    };
    const { data, error } = await db
        .from("organizations")
        .update({ ...policy, updated_at: new Date().toISOString() })
        .eq("id", params.orgId)
        .select("id");
    if (error) return { ok: false, kind: "db_error", detail: error.message };
    if (!data?.length) return { ok: false, kind: "not_found" };

    // One event per setting that changed, so the audit log says which.
    const previous = before as Partial<OrgMemberDataPolicy>;
    for (const [action, column] of Object.entries(COLUMN) as [
        MemberDataAction,
        keyof OrgMemberDataPolicy,
    ][]) {
        if ((previous[column] === true) === policy[column]) continue;
        await recordAudit(db, {
            userId: params.actorId,
            userEmail: params.actorEmail ?? null,
            orgId: params.orgId,
            action: `org.member_${action}s.${policy[column] ? "allowed" : "blocked"}`,
            surface: "organization",
        });
    }
    return { ok: true, policy };
}
