// Explicit permanent organization content purge. Recovery-period deletion stays in orgs.
import { getOrgRole, isOrgAdmin, isOrgOwner } from "../../lib/access";
import { recordAudit } from "../../lib/audit";
import type { OrgResult } from "../../lib/orgs";
import type { Db } from "../../lib/supabase";
import {
    deleteOrgWorkflows,
    deleteOrgDocuments,
    deleteOrgChats,
    deleteOrgMemories,
    deleteOrgPlaybooks,
    deleteOrgProjects,
    deleteOrgTabularReviews,
} from "../../modules/orgs/orgs.service";
type Done = OrgResult<Record<never, never>>;
interface OrgActor {
    userId: string;
    userEmail?: string | null;
    orgId: string;
}
export const ORG_DATA_KINDS = [
    "chats",
    "tabular-reviews",
    "projects",
    "memories",
    "playbooks",
] as const;
export type OrgDataKind = (typeof ORG_DATA_KINDS)[number];
export function isOrgDataKind(value: unknown): value is OrgDataKind {
    return ORG_DATA_KINDS.includes(value as OrgDataKind);
}
const PURGE: Record<OrgDataKind, (db: Db, orgId: string) => Promise<unknown>> = {
    chats: deleteOrgChats,
    "tabular-reviews": deleteOrgTabularReviews,
    projects: deleteOrgProjects,
    memories: deleteOrgMemories,
    playbooks: deleteOrgPlaybooks,
};
/**
 * Permanently delete one kind of content across the organization. Owner
 * only: it reaches every member's work, which is the same reach as deleting
 * the organization itself.
 */
export async function deleteOrgData(
    db: Db,
    params: OrgActor & { kind: OrgDataKind },
): Promise<Done> {
    const role = await getOrgRole(params.userId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(role)) return { ok: false, kind: "forbidden" };
    if (!isOrgOwner(role)) return { ok: false, kind: "owner_required" };

    try {
        await PURGE[params.kind](db, params.orgId);
    } catch (error) {
        return {
            ok: false,
            kind: "db_error",
            detail:
                error instanceof Error
                    ? error.message
                    : "Failed to delete organization data",
        };
    }

    await recordAudit(db, {
        userId: params.userId,
        userEmail: params.userEmail ?? null,
        action: "org.data.deleted",
        detail: { org_id: params.orgId, kind: params.kind },
    });
    return { ok: true };
}
/**
 * Everything the organization owns. Projects go first because their cascade
 * takes most documents, chats and reviews with them; what is left is content
 * tagged to the organization outside any project.
 */
export async function deleteOrgContent(db: Db, orgId: string): Promise<void> {
    await deleteOrgProjects(db, orgId);
    await deleteOrgWorkflows(db, orgId);
    await deleteOrgDocuments(db, orgId);
    await deleteOrgTabularReviews(db, orgId);
    await deleteOrgChats(db, orgId);
}
