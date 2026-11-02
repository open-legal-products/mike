import type { DeletedOrganization } from "@mike/contracts";
import type { Db } from "../../lib/supabase";
import {
    failure,
    internalFailure,
    ok,
    type ServiceResult,
} from "../../lib/serviceResult";

/** Recovery is deliberately separate from the active workspace list. */
export async function listDeletedOrganizations(
    db: Db,
    userId: string,
): Promise<ServiceResult<DeletedOrganization[]>> {
    const { data, error } = await db
        .from("org_members")
        .select("organizations!inner(id, name, deleted_at, purge_after)")
        .eq("user_id", userId)
        .eq("role", "owner")
        .not("organizations.deleted_at", "is", null)
        .gt("organizations.purge_after", new Date().toISOString());
    if (error) return internalFailure(error);
    return ok(
        (data ?? []).flatMap((row) => {
            const org = row.organizations as unknown as
                DeletedOrganization | DeletedOrganization[];
            return Array.isArray(org) ? org : org ? [org] : [];
        }),
    );
}

export async function restoreOrganization(
    db: Db,
    orgId: string,
    userId: string,
): Promise<ServiceResult<null>> {
    const { error } = await db.rpc("restore_organization", {
        p_org_id: orgId,
        p_actor_id: userId,
    });
    if (error?.code === "P0002" || error?.code === "22P02")
        return failure("not_found", "Organization not found.");
    if (error?.code === "42501")
        return failure("forbidden", "Only organization owners can restore it.");
    if (error?.code === "23514")
        return failure(
            "conflict",
            "The organization's recovery period has ended.",
        );
    if (error) return internalFailure(error);
    return ok(null);
}

export async function purgeExpiredOrganizations(db: Db): Promise<number> {
    const { data, error } = await db.rpc("purge_expired_organizations", {
        p_limit: 10,
    });
    if (error)
        throw new Error("Could not purge expired organizations", {
            cause: error,
        });
    return Number(data ?? 0);
}
