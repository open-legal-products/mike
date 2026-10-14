// Business logic + data-access for the organizations / RBAC module.
//
// These functions are the service layer behind modules/orgs/orgs.routes.ts. They take an
// explicit Supabase client (`db`) plus request-derived primitives, enforce the
// owner/admin/member role model, and RETURN typed discriminated results the
// thin route handlers map onto HTTP status codes. They never touch req/res.
//
// Role model (see also backend/src/lib/access.ts):
//   owner  — accountable for the organization: everything an admin can do,
//            plus deleting it and appointing or removing admins and owners.
//   admin  — runs the organization day to day: settings, invitations, and
//            removing members.
//   member — reads the organization and its roster. No org mutations.
// Organization content is private by default. Ordinary access follows
// creation, sharing, public visibility and ownerless recovery. Owners and
// permitted admins can also explicitly open audited read-only private access.
//
// Nobody acts on a peer or a superior, owners excepted (canManageOrgRole): an
// admin cannot appoint a second admin, promote themselves or remove an owner.
//
// Several people may be owners. An earlier owner tier that only one person
// could hold made every org a single point of failure; the database instead
// guarantees an org always retains at least one owner
// (org_members_protect_last_owner), and owners are peers.
//
// Membership is never granted directly. An admin creates an INVITATION; the
// org_members row appears only when the invited account accepts it. Adding
// someone to a firm workspace exposes confidential content, so it takes the
// recipient's consent, not just the inviter's intent.

import type { OrgMemberHandover } from "@mike/contracts";
import { listOrgPrivateContentAccess } from "./orgPrivateContent";
import type { Db } from "./supabase";
import { recordAudit } from "./audit";
import {
    canManageOrgRole,
    getOrgRole,
    isOrgAdmin,
    isOrgOwner,
    isOrgRole,
    loadOwnerlessOrgItemIds,
    normalizeEmail,
    resolveOrgContentRole,
    strongerOrgRole,
    type OrgRole,
} from "./access";
import { isOrgAccessOverrideRole } from "./orgAccessOverrides";
import { isPersonalOrgRow } from "./personalOrgs";

type DbError = { code?: string; message: string } | null;

/** How long a pending invitation stays acceptable. */
export const INVITATION_TTL_DAYS = 14;

/**
 * Every table that carries its own `org_id` — the complete inventory of what
 * an organization can directly own.
 *
 * ONE list, because two different call sites ask the same question and used
 * to disagree about the answer: `deleteOrg` below (may this org be deleted?)
 * and account deletion (`listOrgsBlockingAccountDeletion` in
 * modules/user/user.dataCleanup.ts). The account-deletion probe omitted
 * `chats`, so an org whose only remaining content was a chat looked empty and
 * was deleted — while `deleteOrg` refused the very same delete over the API.
 *
 * Every one of these foreign keys is ON DELETE RESTRICT, so an incomplete
 * probe does not silently detach content: the database refuses the delete and
 * the caller gets a raw constraint error instead of an intentional 409. The
 * probe exists to answer first.
 */
export const ORG_CONTENT_TABLES = [
    "projects",
    "documents",
    "chats",
    "tabular_reviews",
    "workflows",
] as const;

export type InvitationStatus =
    | "pending"
    | "accepted"
    | "declined"
    | "cancelled"
    | "expired";

/**
 * The existence pre-checks in createInvitation race with concurrent inserts;
 * the unique indexes backstop correctness, but a raw 23505 would surface as a
 * 500. Map it onto the same 409 the sequential path returns.
 */
function isUniqueViolation(error: DbError): boolean {
    return error?.code === "23505";
}

/**
 * The org_members_protect_last_owner trigger closes the read-then-act race on
 * last-owner protection at the DB level; when it fires, translate its 23514
 * into the same `last_owner` result the sequential in-process check produces.
 */
function isLastOwnerViolation(error: DbError): boolean {
    return (
        error?.code === "23514" &&
        (error?.message ?? "").includes("at least one owner")
    );
}

export type OrgResult<T> =
    | ({ ok: true } & T)
    | { ok: false; kind: "validation"; detail: string }
    | { ok: false; kind: "forbidden" }
    // An admin asked for something only an owner may do. Separate from
    // `forbidden` so the refusal can name the role that would be allowed.
    | { ok: false; kind: "owner_required" }
    | { ok: false; kind: "not_found" }
    | { ok: false; kind: "conflict"; detail: string }
    | { ok: false; kind: "last_owner" }
    // The member alone owns projects or workflows, and nobody was named to
    // take them over. The counts let the client say what is waiting.
    | {
          ok: false;
          kind: "handover_required";
          projects: number;
          workflows: number;
      }
    | { ok: false; kind: "expired" }
    | { ok: false; kind: "db_error"; detail: string };

// ---------------------------------------------------------------------------
// Org CRUD
// ---------------------------------------------------------------------------

export async function listMyOrgs(
    db: Db,
    userId: string,
): Promise<OrgResult<{ orgs: unknown[] }>> {
    const { data: memberships, error } = await db
        .from("org_members")
        .select("org_id, role")
        .eq("user_id", userId);
    if (error) return { ok: false, kind: "db_error", detail: error.message };

    const rows = (memberships ?? []) as { org_id: string; role: OrgRole }[];
    const roleByOrg = new Map<string, OrgRole>();
    for (const r of rows) roleByOrg.set(r.org_id, r.role);
    const orgIds = [...roleByOrg.keys()];
    if (orgIds.length === 0) return { ok: true, orgs: [] };

    const { data: allOrgs, error: orgsError } = await db
        .from("organizations")
        .select("*")
        .in("id", orgIds)
        .is("deleted_at", null);
    if (orgsError)
        return { ok: false, kind: "db_error", detail: orgsError.message };
    // A person's own organization is not one of "their organizations".
    const orgs = ((allOrgs ?? []) as { id: string }[]).filter(
        (org) => !isPersonalOrgRow(org),
    );

    // Roster sizes let the UI render "N members" without a second round-trip
    // per org.
    const { data: allMembers } = await db
        .from("org_members")
        .select("org_id")
        .in("org_id", orgIds);
    const memberCounts = new Map<string, number>();
    for (const row of (allMembers ?? []) as { org_id?: string | null }[]) {
        if (!row.org_id) continue;
        memberCounts.set(row.org_id, (memberCounts.get(row.org_id) ?? 0) + 1);
    }

    const enriched = orgs.map((o) => ({
        ...o,
        role: roleByOrg.get(o.id) ?? null,
        member_count: memberCounts.get(o.id) ?? 0,
    }));
    return { ok: true, orgs: enriched };
}

export async function createOrg(
    db: Db,
    params: { userId: string; name: unknown; userEmail?: string | null },
): Promise<OrgResult<{ org: Record<string, unknown> }>> {
    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (!name)
        return { ok: false, kind: "validation", detail: "name is required" };

    const { data: org, error } = await db
        .from("organizations")
        .insert({ name, created_by: params.userId })
        .select("*")
        .single();
    if (error || !org)
        return {
            ok: false,
            kind: "db_error",
            detail: error?.message ?? "Failed to create organization",
        };

    // The creator is the org's first owner. This is the ONLY path that writes
    // org_members without an accepted invitation.
    const { error: memberError } = await db
        .from("org_members")
        .insert({ org_id: org.id, user_id: params.userId, role: "owner" });
    if (memberError) {
        // Roll back the org so we never leave an org without an owner.
        await db.from("organizations").delete().eq("id", org.id);
        return { ok: false, kind: "db_error", detail: memberError.message };
    }

    await recordAudit(db, {
        userId: params.userId, userEmail: params.userEmail,
        orgId: String(org.id), action: "org.created", title: name, surface: "organization",
    });
    return { ok: true, org: { ...org, role: "owner", member_count: 1 } };
}

export async function getOrg(
    db: Db,
    params: { userId: string; orgId: string },
): Promise<OrgResult<{ org: Record<string, unknown> }>> {
    const role = await getOrgRole(params.userId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };

    const { data: org, error } = await db
        .from("organizations")
        .select("*")
        .eq("id", params.orgId)
        .maybeSingle();
    if (error || !org) return { ok: false, kind: "not_found" };
    const { data: membership, error: permissionError } = await db
        .from("org_members")
        .select("can_access_private_content")
        .eq("org_id", params.orgId)
        .eq("user_id", params.userId)
        .maybeSingle();
    if (permissionError) return { ok: false, kind: "db_error", detail: permissionError.message };
    return {
        ok: true,
        org: {
            ...org, role,
            can_access_private_content: role === "owner" ||
                (role === "admin" && membership?.can_access_private_content === true),
        },
    };
}

export async function updateOrg(
    db: Db,
    params: { userId: string; orgId: string; name: unknown },
): Promise<OrgResult<{ org: Record<string, unknown> }>> {
    const role = await getOrgRole(params.userId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(role)) return { ok: false, kind: "forbidden" };

    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (!name)
        return { ok: false, kind: "validation", detail: "name is required" };

    const { data: org, error } = await db
        .from("organizations")
        .update({ name, updated_at: new Date().toISOString() })
        .eq("id", params.orgId)
        .select("*")
        .single();
    if (error || !org)
        return {
            ok: false,
            kind: "db_error",
            detail: error?.message ?? "Failed to update organization",
        };
    return getOrg(db, params);
}

/** Owner-only soft deletion. Content stays recoverable for 30 days. */
export async function deleteOrg(
    db: Db,
    params: { userId: string; userEmail?: string | null; orgId: string },
): Promise<OrgResult<Record<never, never>>> {
    const role = await getOrgRole(params.userId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(role)) return { ok: false, kind: "forbidden" };
    if (!isOrgOwner(role)) return { ok: false, kind: "owner_required" };
    const { error } = await db.rpc("soft_delete_organization", { p_org_id: params.orgId, p_actor_id: params.userId });
    if (error?.code === "P0002" || error?.code === "22P02") return { ok: false, kind: "not_found" };
    if (error?.code === "42501") return { ok: false, kind: "owner_required" };
    if (error) return { ok: false, kind: "db_error", detail: error.message };
    return { ok: true };
}

/**
 * The organization's projects and workflows, as the CALLER may see them.
 *
 * Membership is what makes this list reachable, but it is not what decides
 * its contents. Inside an organization a project or workflow is private until
 * it is shared or made public, so most of what the organization holds is not
 * a given member's to see — and the columns here (a project's name and its
 * cm_number, a workflow's title) are exactly the detail privacy withholds.
 * Listing a row whose link then 404s leaks the thing it was meant to hide.
 *
 * The verdict per row is resolveOrgContentRole, the same one the single-item
 * checks and the SQL role functions reach. An organization owner is listed
 * what is public and what has no Owner left — not a member's private work.
 */
export async function listOrgResources(
    db: Db,
    params: { userId: string; orgId: string },
): Promise<
    OrgResult<{
        projects: unknown[];
        workflows: unknown[];
    }>
> {
    const role = await getOrgRole(params.userId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };

    // One batched read per override table, not one per resource: this is a
    // filter over a page of rows, and it must not become an N+1. Every
    // override the caller holds is read, not only the denials: a grant is
    // what admits a member to a private item.
    const [projectsResult, workflowsResult, projectOverrides, workflowOverrides] =
        await Promise.all([
            db
                .from("projects")
                .select("id, user_id, org_id, visibility, name, cm_number, practice, created_at, updated_at")
                .eq("org_id", params.orgId)
                .is("archived_at", null)
                .order("created_at", { ascending: false }),
            db
                .from("workflows")
                .select(
                    "id, user_id, org_id, visibility, title, type, practice, created_at",
                )
                .eq("org_id", params.orgId)
                .is("archived_at", null)
                .order("created_at", { ascending: false }),
            db
                .from("project_org_access_overrides")
                .select("project_id, role")
                .eq("org_id", params.orgId)
                .eq("user_id", params.userId),
            db
                .from("workflow_org_access_overrides")
                .select("workflow_id, role")
                .eq("org_id", params.orgId)
                .eq("user_id", params.userId),
        ]);
    const failed = [
        projectsResult,
        workflowsResult,
        projectOverrides,
        workflowOverrides,
    ].find((result) => result.error)?.error;
    if (failed)
        return { ok: false, kind: "db_error", detail: failed.message };

    // Fail closed: an unreadable override table is an error above, never an
    // empty map — which would read as "no grants and no denials".
    const overridesBy = (rows: unknown, key: string) =>
        new Map(
            ((rows ?? []) as Record<string, unknown>[])
                .filter((row) => typeof row[key] === "string")
                .map((row) => [row[key] as string, row.role]),
        );
    const projectOverrideById = overridesBy(projectOverrides.data, "project_id");
    const workflowOverrideById = overridesBy(
        workflowOverrides.data,
        "workflow_id",
    );

    const ownerless = await loadOwnerlessOrgItemIds(
        db,
        isOrgOwner(role) ? [params.orgId] : [],
    );

    const privateAccess = await listOrgPrivateContentAccess(
        db, isOrgAdmin(role) ? [params.orgId] : [], params.userId,
    );

    const visible = <
        T extends { id?: unknown; user_id?: unknown; visibility?: unknown },
    >(
        rows: T[],
        overrideById: Map<string, unknown>,
        ownerlessIds: Set<string>,
        privateIds?: Set<string>,
    ) =>
        rows.filter((row) => {
            const override =
                typeof row.id === "string" ? overrideById.get(row.id) : null;
            return (
                resolveOrgContentRole({
                    isCreator: !!row.user_id && row.user_id === params.userId,
                    orgRole: role,
                    override: isOrgAccessOverrideRole(override)
                        ? override
                        : null,
                    visibility: row.visibility,
                    ownerless:
                        typeof row.id === "string" && ownerlessIds.has(row.id),
                }) !== null || (typeof row.id === "string" && privateIds?.has(row.id) === true)
            );
        });

    type Row = { id?: unknown; user_id?: unknown; visibility?: unknown };
    return {
        ok: true,
        projects: visible(
            (projectsResult.data ?? []) as Row[],
            projectOverrideById,
            ownerless.projects,
            privateAccess.get("project"),
        ),
        workflows: visible(
            (workflowsResult.data ?? []) as Row[],
            workflowOverrideById,
            ownerless.workflows,
            privateAccess.get("workflow"),
        ),
    };
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/**
 * Decorate membership rows with the profile identity the roster UI needs.
 * user_profiles mirrors auth.users' email precisely so sharing/roster reads
 * never scan the auth schema.
 */
async function attachProfiles(
    db: Db,
    rows: { user_id: string }[],
): Promise<Map<string, { email: string | null; display_name: string | null; profile_photo?: string | null }>> {
    const byUser = new Map<
        string,
        { email: string | null; display_name: string | null; profile_photo?: string | null }
    >();
    const userIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
    if (userIds.length === 0) return byUser;
    const { data } = await db
        .from("user_profiles")
        .select("user_id, email, display_name, profile_photo")
        .in("user_id", userIds);
    for (const p of (data ?? []) as {
        user_id: string;
        email: string | null;
        display_name: string | null; profile_photo?: string | null;
    }[]) {
        byUser.set(p.user_id, {
            email: p.email ?? null,
            display_name: p.display_name ?? null,
            profile_photo: p.profile_photo ?? null,
        });
    }
    return byUser;
}

/** Lists organization members and their profile identities after verifying the caller belongs to the organization. */
export async function listMembers(
    db: Db,
    params: { userId: string; orgId: string },
): Promise<OrgResult<{ members: unknown[] }>> {
    const role = await getOrgRole(params.userId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };

    const { data, error } = await db
        .from("org_members")
        .select("id, user_id, role, created_at, can_access_private_content")
        .eq("org_id", params.orgId);
    if (error) return { ok: false, kind: "db_error", detail: error.message };

    const rows = (data ?? []) as {
        id: string;
        user_id: string;
        role: OrgRole;
        created_at: string;
    }[];
    const profiles = await attachProfiles(db, rows);
    return {
        ok: true,
        members: rows.map((m) => ({
            ...m,
            email: profiles.get(m.user_id)?.email ?? null,
            display_name: profiles.get(m.user_id)?.display_name ?? null,
            profile_photo: profiles.get(m.user_id)?.profile_photo ?? null,
        })),
    };
}

async function countOwners(db: Db, orgId: string): Promise<number> {
    const { data } = await db
        .from("org_members")
        .select("user_id")
        .eq("org_id", orgId)
        .eq("role", "owner");
    return ((data ?? []) as unknown[]).length;
}

export async function updateMember(
    db: Db,
    params: {
        actorId: string;
        actorEmail?: string | null;
        orgId: string;
        targetUserId: string;
        role: unknown;
    },
): Promise<OrgResult<{ member: Record<string, unknown> }>> {
    const actorRole = await getOrgRole(params.actorId, params.orgId, db);
    if (!actorRole) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(actorRole)) return { ok: false, kind: "forbidden" };

    if (!isOrgRole(params.role))
        return { ok: false, kind: "validation", detail: "invalid role" };
    const nextRole = params.role;

    const targetRole = await getOrgRole(params.targetUserId, params.orgId, db);
    if (!targetRole) return { ok: false, kind: "not_found" };

    // Both ends of the change are checked: the role the person holds now and
    // the one they would hold after. Checking only the new role would let an
    // admin demote an owner to member; checking only the current one would
    // let an admin promote a member to owner.
    if (
        !canManageOrgRole(actorRole, targetRole) ||
        !canManageOrgRole(actorRole, nextRole)
    )
        return { ok: false, kind: "owner_required" };

    // Last-owner protection: demoting the sole owner would strand the org
    // with nobody able to delete it or appoint an admin.
    if (targetRole === "owner" && nextRole !== "owner") {
        const owners = await countOwners(db, params.orgId);
        if (owners <= 1) return { ok: false, kind: "last_owner" };
    }

    const { data: member, error } = await db
        .from("org_members")
        .update({ role: nextRole, updated_at: new Date().toISOString() })
        .eq("org_id", params.orgId)
        .eq("user_id", params.targetUserId)
        .select("*")
        .single();
    if (error || !member) {
        if (isLastOwnerViolation(error))
            return { ok: false, kind: "last_owner" };
        return {
            ok: false,
            kind: "db_error",
            detail: error?.message ?? "Failed to update member",
        };
    }
    // Role changes move real standing (an org role inherits onto every
    // project the org owns), so they belong in the same audit trail the
    // invitation lifecycle already writes to.
    const profiles = await attachProfiles(db, [
        { user_id: params.targetUserId },
    ]);
    await recordAudit(db, {
        userId: params.actorId,
        userEmail: params.actorEmail ?? null,
        action: "org.member.role_changed",
        title: profiles.get(params.targetUserId)?.email ?? params.targetUserId,
        detail: {
            org_id: params.orgId,
            target_user_id: params.targetUserId,
            previous_role: targetRole,
            role: nextRole,
        },
    });
    return { ok: true, member };
}

/** Shared work to transfer and counts of unshared work to retain for 30 days. */
export type MemberHandover = OrgMemberHandover;

async function loadMemberHandover(
    db: Db,
    orgId: string,
    userIds: string[],
): Promise<{ ok: true; handover: MemberHandover } | { ok: false; detail: string }> {
    const { data, error } = await db.rpc("org_members_departure_items", {
        p_org_id: orgId,
        p_user_ids: userIds,
    });
    // Fail closed until the migration is installed: an empty fallback could
    // remove a member without the shared handover or private retention preview.
    if (error) return { ok: false, detail: error.message };
    const handover: MemberHandover = {
        projects: [],
        workflows: [],
        sharedChats: 0,
        sharedReviews: 0,
        sharedDocuments: 0,
        privateProjects: 0,
        privateWorkflows: 0,
        chats: 0,
        reviews: 0,
        documents: 0,
    };
    for (const row of (data ?? []) as {
        kind: string;
        item_id: string;
        title: string | null;
        disposition: string;
    }[]) {
        if (row.disposition === "transfer") {
            const item = { id: row.item_id, title: row.title === null ? "" : row.title?.trim() || "Untitled" };
            if (row.kind === "project") handover.projects.push(item);
            else if (row.kind === "workflow") handover.workflows.push(item);
            else if (row.kind === "chat") handover.sharedChats += 1;
            else if (row.kind === "tabular_review") handover.sharedReviews += 1;
            else if (row.kind === "document") handover.sharedDocuments += 1;
        } else if (row.disposition === "archive") {
            if (row.kind === "project") handover.privateProjects += 1;
            else if (row.kind === "workflow") handover.privateWorkflows += 1;
            else if (row.kind === "chat") handover.chats += 1;
            else if (row.kind === "tabular_review") handover.reviews += 1;
            else if (row.kind === "document") handover.documents += 1;
        }
    }
    return { ok: true, handover };
}

type RemovalGate =
    | { ok: true; isSelf: boolean; targetRole: OrgRole }
    | Extract<OrgResult<never>, { ok: false }>;

/** Who may take `targetUserId` out of the organization: themselves, or an admin who outranks them. */
async function authorizeRemoval(
    db: Db,
    params: { actorId: string; orgId: string; targetUserId: string },
): Promise<RemovalGate> {
    const actorRole = await getOrgRole(params.actorId, params.orgId, db);
    if (!actorRole) return { ok: false, kind: "not_found" };
    // A member may remove themselves (leave); removing others needs admin.
    const isSelf = params.actorId === params.targetUserId;
    if (!isSelf && !isOrgAdmin(actorRole))
        return { ok: false, kind: "forbidden" };

    const targetRole = await getOrgRole(params.targetUserId, params.orgId, db);
    if (!targetRole) return { ok: false, kind: "not_found" };

    // Leaving is always the member's own call. Removing somebody else is
    // not: an admin may remove members, and only an owner may remove an
    // admin or another owner.
    if (!isSelf && !canManageOrgRole(actorRole, targetRole))
        return { ok: false, kind: "owner_required" };
    return { ok: true, isSelf, targetRole };
}

/**
 * What removing a member (or leaving) would hand over and archive, for the
 * dialog that asks. Answered only to somebody who could go on to do it.
 */
export async function getMemberHandover(
    db: Db,
    params: { actorId: string; orgId: string; targetUserId: string; departingUserIds?: unknown },
): Promise<OrgResult<{ handover: MemberHandover }>> {
    const otherIds = params.departingUserIds;
    if (otherIds !== undefined && (
        !Array.isArray(otherIds) || otherIds.length > 100 ||
        otherIds.some((id) => typeof id !== "string" || !id)
    )) return { ok: false, kind: "validation", detail: "Choose valid organization members." };
    const userIds = [...new Set([params.targetUserId, ...((otherIds ?? []) as string[])])];
    for (const targetUserId of userIds) {
        const gate = await authorizeRemoval(db, { ...params, targetUserId });
        if (!gate.ok) return gate;
    }
    const loaded = await loadMemberHandover(db, params.orgId, userIds);
    if (!loaded.ok)
        return { ok: false, kind: "db_error", detail: loaded.detail };
    return { ok: true, handover: loaded.handover };
}

export async function removeMember(
    db: Db,
    params: {
        actorId: string;
        actorEmail?: string | null;
        orgId: string;
        targetUserId: string;
        /**
         * The member who takes over the shared work the departing member alone owns. Defaults to a remaining
         * organization owner when omitted.
         */
        assignTo?: unknown;
    },
): Promise<OrgResult<Record<never, never>>> {
    const gate = await authorizeRemoval(db, params);
    if (!gate.ok) return gate;
    const { isSelf, targetRole } = gate;

    // Last-owner protection: never remove the sole owner, not even by their
    // own hand — they must appoint a successor first.
    if (targetRole === "owner") {
        const owners = await countOwners(db, params.orgId);
        if (owners <= 1) return { ok: false, kind: "last_owner" };
    }

    // Public projects and workflows without another explicit owner are
    // handed to a named successor before the member goes.
    // Nothing is removed until that has been settled.
    const loaded = await loadMemberHandover(
        db,
        params.orgId,
        [params.targetUserId],
    );
    if (!loaded.ok)
        return { ok: false, kind: "db_error", detail: loaded.detail };
    const { handover } = loaded;
    const assignTo = params.assignTo;
    if (assignTo !== undefined && assignTo !== null && assignTo !== "" && (
        typeof assignTo !== "string" || assignTo === params.targetUserId ||
        !(await getOrgRole(assignTo, params.orgId, db))
    )) return { ok: false, kind: "validation", detail: "Choose another member of this organization to take over the shared work." };

    // The RPC rechecks roles and ownership under an organization lock, then
    // transfers/archives and removes membership in the same transaction.
    const assignedTo = typeof assignTo === "string" && assignTo ? assignTo : null;
    const { error } = await db.rpc("remove_org_member", {
        p_org_id: params.orgId,
        p_user_id: params.targetUserId,
        p_actor_id: params.actorId,
        p_successor_id: assignedTo,
    });
    if (error) {
        if (isLastOwnerViolation(error)) return { ok: false, kind: "last_owner" };
        if (error.code === "42501") return { ok: false, kind: "forbidden" };
        if (error.code === "P0002") return { ok: false, kind: "not_found" };
        if (error.code === "23514") return { ok: false, kind: "validation", detail: "Choose another current organization member." };
        return { ok: false, kind: "db_error", detail: error.message };
    }
    const profiles = await attachProfiles(db, [
        { user_id: params.targetUserId },
    ]);
    await recordAudit(db, {
        userId: params.actorId,
        userEmail: params.actorEmail ?? null,
        action: isSelf ? "org.member.left" : "org.member.removed",
        title: profiles.get(params.targetUserId)?.email ?? params.targetUserId,
        detail: {
            org_id: params.orgId,
            target_user_id: params.targetUserId,
            role: targetRole,
            // What became of their work: who took over what they alone
            // owned, and how much of what was private to them was archived.
            assigned_to: assignedTo,
            assigned_projects: handover.projects.length,
            assigned_workflows: handover.workflows.length,
            assigned_chats: handover.sharedChats,
            assigned_reviews: handover.sharedReviews,
            assigned_documents: handover.sharedDocuments,
            archived_projects: handover.privateProjects,
            archived_workflows: handover.privateWorkflows,
            archived_chats: handover.chats,
            archived_reviews: handover.reviews,
            archived_documents: handover.documents,
        },
    });
    return { ok: true };
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

type InvitationRow = {
    id: string;
    org_id: string;
    email: string;
    role: OrgRole;
    invited_by: string | null;
    status: InvitationStatus;
    expires_at: string;
    created_at: string;
    accepted_at: string | null;
    declined_at: string | null;
    cancelled_at: string | null;
};

/**
 * The roles an invitation may carry. Ownership is never offered to an email
 * address: an owner grants it to somebody who has already joined, through
 * updateMember, where both people are known to the organization.
 */
type InvitableRole = Exclude<OrgRole, "owner">;

function isInvitableRole(value: unknown): value is InvitableRole {
    return value === "admin" || value === "member";
}

function isExpired(row: { status: string; expires_at: string }): boolean {
    return (
        row.status === "pending" && new Date(row.expires_at).getTime() <= Date.now()
    );
}

/**
 * Expiry is evaluated lazily on read rather than by a sweeper job: a pending
 * invitation past its expires_at reports as `expired` and cannot be accepted.
 * The stored status stays 'pending' until someone acts on it, so there is no
 * background writer racing the accept path.
 */
function presentInvitation(row: InvitationRow) {
    return { ...row, status: isExpired(row) ? "expired" : row.status };
}

function invitationExpiry(): string {
    return new Date(
        Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
}

export async function createInvitation(
    db: Db,
    params: {
        actorId: string;
        actorEmail?: string | null;
        orgId: string;
        email: unknown;
        role: unknown;
    },
): Promise<OrgResult<{ invitation: Record<string, unknown> }>> {
    const actorRole = await getOrgRole(params.actorId, params.orgId, db);
    if (!actorRole) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(actorRole)) return { ok: false, kind: "forbidden" };

    const email =
        typeof params.email === "string" ? normalizeEmail(params.email) : null;
    if (!email || !email.includes("@"))
        return {
            ok: false,
            kind: "validation",
            detail: "A valid email address is required",
        };
    const actorEmail = normalizeEmail(params.actorEmail);
    if (actorEmail && actorEmail === email)
        return {
            ok: false,
            kind: "validation",
            detail: "You are already a member of this organization",
        };

    // Omitting the role still means "member" — that is the documented
    // default. Naming one that does not exist is a different thing, and it
    // gets the same 400 that updateMember and project sharing already give.
    // Coercing 'owner' to 'member' behind a 201 would answer a request for a
    // tier this product deleted by inventing a quieter one, and the caller
    // would have no way to tell.
    if (
        params.role !== undefined &&
        params.role !== null &&
        !isInvitableRole(params.role)
    )
        return {
            ok: false,
            kind: "validation",
            detail: "Role must be admin or member",
        };
    const role: InvitableRole = isInvitableRole(params.role)
        ? params.role
        : "member";
    // Inviting somebody as an admin is appointing an admin, which is an
    // owner's decision however the person arrives.
    if (!canManageOrgRole(actorRole, role))
        return { ok: false, kind: "owner_required" };

    // Someone who already belongs here needs no invitation. Resolved through
    // the mirrored profile email so the check never scans auth.users.
    const { data: profile } = await db
        .from("user_profiles")
        .select("user_id")
        .eq("email", email)
        .maybeSingle();
    const existingUserId = (profile as { user_id?: string } | null)?.user_id;
    if (existingUserId) {
        const existingRole = await getOrgRole(
            existingUserId,
            params.orgId,
            db,
        );
        if (existingRole)
            return {
                ok: false,
                kind: "conflict",
                detail: "That person is already a member of this organization",
            };
    }

    // One live invitation per (org, email). A previously expired one is
    // re-openable: refresh it in place rather than accumulating dead rows.
    const { data: existingInvite } = await db
        .from("org_invitations")
        .select("*")
        .eq("org_id", params.orgId)
        .eq("email", email)
        .eq("status", "pending")
        .maybeSingle();
    const live = existingInvite as InvitationRow | null;
    if (live && !isExpired(live))
        return {
            ok: false,
            kind: "conflict",
            detail: "That email already has a pending invitation",
        };
    if (live) {
        const { data: refreshed, error: refreshError } = await db
            .from("org_invitations")
            .update({
                role,
                invited_by: params.actorId,
                expires_at: invitationExpiry(),
            })
            .eq("id", live.id)
            .select("*")
            .single();
        if (refreshError || !refreshed)
            return {
                ok: false,
                kind: "db_error",
                detail: refreshError?.message ?? "Failed to create invitation",
            };
        await recordAudit(db, {
            userId: params.actorId,
            userEmail: params.actorEmail ?? null,
            action: "org.invite.created",
            title: email,
            detail: { org_id: params.orgId, role, invitation_id: live.id },
        });
        return {
            ok: true,
            invitation: presentInvitation(refreshed as InvitationRow),
        };
    }

    const { data: invitation, error } = await db
        .from("org_invitations")
        .insert({
            org_id: params.orgId,
            email,
            role,
            invited_by: params.actorId,
            status: "pending",
            expires_at: invitationExpiry(),
        })
        .select("*")
        .single();
    if (error || !invitation) {
        if (isUniqueViolation(error))
            return {
                ok: false,
                kind: "conflict",
                detail: "That email already has a pending invitation",
            };
        return {
            ok: false,
            kind: "db_error",
            detail: error?.message ?? "Failed to create invitation",
        };
    }
    await recordAudit(db, {
        userId: params.actorId,
        userEmail: params.actorEmail ?? null,
        action: "org.invite.created",
        title: email,
        detail: {
            org_id: params.orgId,
            role,
            invitation_id: (invitation as { id: string }).id,
        },
    });
    return {
        ok: true,
        invitation: presentInvitation(invitation as InvitationRow),
    };
}

export async function listInvitations(
    db: Db,
    params: { userId: string; orgId: string },
): Promise<OrgResult<{ invitations: unknown[] }>> {
    const role = await getOrgRole(params.userId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };
    // The roster of who has been asked to join is administrative detail.
    if (!isOrgAdmin(role)) return { ok: false, kind: "forbidden" };

    const { data, error } = await db
        .from("org_invitations")
        .select("*")
        .eq("org_id", params.orgId)
        .order("created_at", { ascending: false });
    if (error) return { ok: false, kind: "db_error", detail: error.message };
    const rows = (data ?? []) as InvitationRow[];
    const profiles = await attachProfiles(
        db,
        rows
            .filter((r) => r.invited_by)
            .map((r) => ({ user_id: r.invited_by as string })),
    );
    return {
        ok: true,
        invitations: rows.map((r) => ({
            ...presentInvitation(r),
            invited_by_email: r.invited_by
                ? (profiles.get(r.invited_by)?.email ?? null)
                : null,
        })),
    };
}

export async function cancelInvitation(
    db: Db,
    params: {
        actorId: string;
        actorEmail?: string | null;
        orgId: string;
        invitationId: string;
    },
): Promise<OrgResult<Record<never, never>>> {
    const actorRole = await getOrgRole(params.actorId, params.orgId, db);
    if (!actorRole) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(actorRole)) return { ok: false, kind: "forbidden" };

    const { data: invite } = await db
        .from("org_invitations")
        .select("*")
        .eq("id", params.invitationId)
        .eq("org_id", params.orgId)
        .maybeSingle();
    const row = invite as InvitationRow | null;
    if (!row) return { ok: false, kind: "not_found" };
    // An admin invitation is an owner's appointment in progress; an admin
    // withdrawing it would be overruling one.
    if (!canManageOrgRole(actorRole, row.role))
        return { ok: false, kind: "owner_required" };
    // A cancelled invitation was withdrawn by an admin, not answered by the
    // recipient — reporting it as "already answered" tells them something
    // untrue about their own actions. It reads as missing instead, which is
    // the branch the client's "may have been cancelled" copy is written for.
    if (row.status === "cancelled") return { ok: false, kind: "not_found" };
    if (row.status !== "pending")
        return {
            ok: false,
            kind: "conflict",
            detail: "That invitation has already been answered",
        };

    const { error } = await db
        .from("org_invitations")
        .update({
            status: "cancelled",
            cancelled_at: new Date().toISOString(),
        })
        .eq("id", row.id);
    if (error) return { ok: false, kind: "db_error", detail: error.message };
    await recordAudit(db, {
        userId: params.actorId,
        userEmail: params.actorEmail ?? null,
        action: "org.invite.cancelled",
        title: row.email,
        detail: { org_id: params.orgId, invitation_id: row.id },
    });
    return { ok: true };
}

export async function resendInvitation(
    db: Db,
    params: {
        actorId: string;
        actorEmail?: string | null;
        orgId: string;
        invitationId: string;
    },
): Promise<OrgResult<{ invitation: Record<string, unknown> }>> {
    const actorRole = await getOrgRole(params.actorId, params.orgId, db);
    if (!actorRole) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(actorRole)) return { ok: false, kind: "forbidden" };

    const { data: invite } = await db
        .from("org_invitations")
        .select("*")
        .eq("id", params.invitationId)
        .eq("org_id", params.orgId)
        .maybeSingle();
    const row = invite as InvitationRow | null;
    if (!row) return { ok: false, kind: "not_found" };
    // Extending an admin invitation keeps an appointment open, so it takes
    // the same standing as making one.
    if (!canManageOrgRole(actorRole, row.role))
        return { ok: false, kind: "owner_required" };
    // Resending an answered invitation would silently re-open a decision the
    // recipient already made. Only pending ones (expired included) refresh.
    // A cancelled invitation was withdrawn by an admin, not answered by the
    // recipient — reporting it as "already answered" tells them something
    // untrue about their own actions. It reads as missing instead, which is
    // the branch the client's "may have been cancelled" copy is written for.
    if (row.status === "cancelled") return { ok: false, kind: "not_found" };
    if (row.status !== "pending")
        return {
            ok: false,
            kind: "conflict",
            detail: "That invitation has already been answered",
        };

    const { data: refreshed, error } = await db
        .from("org_invitations")
        .update({ expires_at: invitationExpiry() })
        .eq("id", row.id)
        .select("*")
        .single();
    if (error || !refreshed)
        return {
            ok: false,
            kind: "db_error",
            detail: error?.message ?? "Failed to resend invitation",
        };
    await recordAudit(db, {
        userId: params.actorId,
        userEmail: params.actorEmail ?? null,
        action: "org.invite.resent",
        title: row.email,
        detail: { org_id: params.orgId, invitation_id: row.id },
    });
    return {
        ok: true,
        invitation: presentInvitation(refreshed as InvitationRow),
    };
}

/**
 * Invitations addressed to the caller. Matching is by normalized email, which
 * is what makes claim-after-signup work: an invitation created before the
 * recipient had an account is waiting for them the moment their profile
 * carries that address.
 */
export async function listMyInvitations(
    db: Db,
    params: { userEmail?: string | null },
): Promise<OrgResult<{ invitations: unknown[] }>> {
    const email = normalizeEmail(params.userEmail);
    if (!email) return { ok: true, invitations: [] };

    const { data, error } = await db
        .from("org_invitations")
        .select("*")
        .eq("email", email)
        .eq("status", "pending")
        .order("created_at", { ascending: false });
    if (error) return { ok: false, kind: "db_error", detail: error.message };

    const rows = ((data ?? []) as InvitationRow[]).filter((r) => !isExpired(r));
    if (rows.length === 0) return { ok: true, invitations: [] };

    const orgIds = [...new Set(rows.map((r) => r.org_id))];
    const { data: orgs } = await db
        .from("organizations")
        .select("id, name")
        .in("id", orgIds)
        .is("deleted_at", null);
    const nameById = new Map(
        ((orgs ?? []) as { id: string; name: string }[]).map((o) => [
            o.id,
            o.name,
        ]),
    );
    const profiles = await attachProfiles(
        db,
        rows
            .filter((r) => r.invited_by)
            .map((r) => ({ user_id: r.invited_by as string })),
    );
    return {
        ok: true,
        invitations: rows.filter((r) => nameById.has(r.org_id)).map((r) => ({
            ...presentInvitation(r),
            org_name: nameById.get(r.org_id) ?? null,
            invited_by_email: r.invited_by
                ? (profiles.get(r.invited_by)?.email ?? null)
                : null,
        })),
    };
}

/** Load an invitation and verify it is this caller's to answer. */
async function loadAnswerableInvitation(
    db: Db,
    params: { userEmail?: string | null; invitationId: string },
): Promise<
    | { ok: true; invitation: InvitationRow }
    | Extract<OrgResult<unknown>, { ok: false }>
> {
    const email = normalizeEmail(params.userEmail);
    const { data } = await db
        .from("org_invitations")
        .select("*, organizations!inner(id)")
        .is("organizations.deleted_at", null)
        .eq("id", params.invitationId)
        .maybeSingle();
    const row = data as InvitationRow | null;
    // An invitation addressed to somebody else is reported as missing rather
    // than forbidden: otherwise the 403/404 split would confirm that a given
    // invitation id exists for some other address.
    if (!row || !email || row.email !== email)
        return { ok: false, kind: "not_found" };
    // A cancelled invitation was withdrawn by an admin, not answered by the
    // recipient — reporting it as "already answered" tells them something
    // untrue about their own actions. It reads as missing instead, which is
    // the branch the client's "may have been cancelled" copy is written for.
    if (row.status === "cancelled") return { ok: false, kind: "not_found" };
    if (row.status !== "pending")
        return {
            ok: false,
            kind: "conflict",
            detail: "That invitation has already been answered",
        };
    if (isExpired(row)) return { ok: false, kind: "expired" };
    return { ok: true, invitation: row };
}

export async function acceptInvitation(
    db: Db,
    params: {
        userId: string;
        userEmail?: string | null;
        invitationId: string;
    },
): Promise<OrgResult<{ org_id: string; role: OrgRole }>> {
    const loaded = await loadAnswerableInvitation(db, params);
    if (!loaded.ok) return loaded;
    const invite = loaded.invitation;

    // Acceptance is the only door through which org_members rows appear
    // (apart from an org's creator). Idempotent for the already-a-member
    // case: mark the invitation answered rather than 500ing on the unique.
    const existing = await getOrgRole(params.userId, invite.org_id, db);
    // Roles are FLOORS, not ceilings. Accepting an admin invitation while
    // already a member raises you to admin; accepting a member invitation
    // while already an admin or owner leaves you where you are, because an
    // invitation is an offer of access, not an instruction to reduce it.
    // Demotion is what PATCH /orgs/:orgId/members exists for, where an owner
    // does it on purpose and the last-owner guard gets a say.
    const effectiveRole: OrgRole = existing
        ? strongerOrgRole(existing, invite.role)
        : invite.role;

    if (!existing) {
        const { error } = await db.from("org_members").insert({
            org_id: invite.org_id,
            user_id: params.userId,
            role: effectiveRole,
        });
        if (error && !isUniqueViolation(error))
            return { ok: false, kind: "db_error", detail: error.message };
    } else if (effectiveRole !== existing) {
        const { error } = await db
            .from("org_members")
            .update({ role: effectiveRole, updated_at: new Date().toISOString() })
            .eq("org_id", invite.org_id)
            .eq("user_id", params.userId);
        if (error) return { ok: false, kind: "db_error", detail: error.message };
    }

    const { error: updateError } = await db
        .from("org_invitations")
        .update({ status: "accepted", accepted_at: new Date().toISOString() })
        .eq("id", invite.id);
    if (updateError)
        return { ok: false, kind: "db_error", detail: updateError.message };

    await recordAudit(db, {
        userId: params.userId,
        userEmail: params.userEmail ?? null,
        action: "org.invite.accepted",
        title: invite.email,
        detail: {
            org_id: invite.org_id,
            // The role now in force, not the one that was offered: an audit
            // trail that records the offer cannot answer "what changed?".
            role: effectiveRole,
            invited_role: invite.role,
            invitation_id: invite.id,
        },
    });
    return { ok: true, org_id: invite.org_id, role: effectiveRole };
}

export async function declineInvitation(
    db: Db,
    params: {
        userId: string;
        userEmail?: string | null;
        invitationId: string;
    },
): Promise<OrgResult<Record<never, never>>> {
    const loaded = await loadAnswerableInvitation(db, params);
    if (!loaded.ok) return loaded;
    const invite = loaded.invitation;

    const { error } = await db
        .from("org_invitations")
        .update({ status: "declined", declined_at: new Date().toISOString() })
        .eq("id", invite.id);
    if (error) return { ok: false, kind: "db_error", detail: error.message };

    await recordAudit(db, {
        userId: params.userId,
        userEmail: params.userEmail ?? null,
        action: "org.invite.declined",
        title: invite.email,
        detail: { org_id: invite.org_id, invitation_id: invite.id },
    });
    return { ok: true };
}
