import type { Db } from "./supabase";
import {
    hasOrgPrivateContentAccess,
    listOrgPrivateContentAccess,
} from "./orgPrivateContent";

/**
 * Project / document access helpers.
 *
 * Sharing makes the previous "scope by user_id" pattern incorrect — a doc
 * can belong to user A's project that A has shared with B's email, and B
 * must still be able to read/edit it. These helpers centralize the
 * exclusive organization-or-direct scope check so every route uses the same
 * logic instead of re-implementing the join.
 *
 * The creator is Owner. For personal content, access otherwise comes from one
 * role-aware direct grant. Projects and workflows may instead belong to an
 * organization, where they are PRIVATE BY DEFAULT: reachable by the creator,
 * and by the members they have been shared with
 * (a per-resource override of Owner, Editor, Viewer — or Deny, which walls a
 * member off). Making one public gives every member Editor. Sharing never
 * reaches outside the organization. A chat or review in a project inherits
 * the project's access. One started on its own in an organization's
 * workspace belongs to that organization and is private to its author
 * (`ensureSharedRowAccess`).
 *
 * `resolveOrgContentRole` below is that rule; public.project_access_role and
 * public.workflow_access_role in schema.sql are its SQL twins.
 *
 * Personal content is still `org_id IS NULL`: each account has a personal
 * organization of its own (lib/personalOrgs.ts), but no work has moved into
 * it. Content without an org is reachable through branches 1 and 2 only.
 */

import {
    getContentGrantRole,
    type ContentGrantKind,
} from "./contentAccess";
import { isPersonalOrg, teamOrgIdOf } from "./personalOrgs";
import {
    can,
    isProjectRole,
    type ProjectRole,
} from "./permissions";
import {
    getOrgAccessOverrideRole,
    isOrgAccessOverrideRole,
    type OrgAccessOverrideRole,
    type OrgResourceKind,
} from "./orgAccessOverrides";

export {
    can,
    isProjectRole,
    type ProjectRole,
} from "./permissions";

/**
 * Organizations have three roles, strongest first. Owners are accountable for
 * the organization: they alone delete it and appoint or remove admins and
 * other owners. Admins run it day to day (members, invitations, settings).
 * Members collaborate. Owners manage public and ownerless projects/workflows.
 * For private items still owned by another member, owners and permitted admins
 * must explicitly open read-only access through the audited private-content path.
 */
export type OrgRole = "owner" | "admin" | "member";

export const ORG_ROLES: OrgRole[] = ["owner", "admin", "member"];

const ORG_ROLE_RANK: Record<OrgRole, number> = {
    member: 0,
    admin: 1,
    owner: 2,
};

export function isOrgRole(value: unknown): value is OrgRole {
    return typeof value === "string" && (ORG_ROLES as string[]).includes(value);
}

/** Only an org owner may delete the org or decide who administers it. */
export function isOrgOwner(role: OrgRole | null | undefined): boolean {
    return role === "owner";
}

/**
 * Whether the role may administer an org (members, invitations, settings).
 * An owner can do everything an admin can.
 */
export function isOrgAdmin(role: OrgRole | null | undefined): boolean {
    return role === "owner" || role === "admin";
}

/** The stronger of two organization roles. */
export function strongerOrgRole(a: OrgRole, b: OrgRole): OrgRole {
    return ORG_ROLE_RANK[a] >= ORG_ROLE_RANK[b] ? a : b;
}

/**
 * Whether `actor` may give somebody `role`, or act on somebody who holds it:
 * invite at it, change it, remove its holder.
 *
 * Owners are peers and may act at every level, their own included. Everyone
 * else acts only strictly below themselves, which is what stops an admin
 * from appointing a second admin, promoting themselves or removing an owner.
 */
export function canManageOrgRole(
    actor: OrgRole | null | undefined,
    role: OrgRole,
): boolean {
    if (!actor) return false;
    if (actor === "owner") return true;
    return ORG_ROLE_RANK[actor] > ORG_ROLE_RANK[role];
}

/** Who may open an organization's project or workflow without being named. */
export type ContentVisibility = "private" | "organization";

export function isContentVisibility(value: unknown): value is ContentVisibility {
    return value === "private" || value === "organization";
}

/**
 * Read a `visibility` an API caller sent for a project or workflow.
 *
 * Absent means "leave it as it is" (private, for a new item). Public is only
 * meaningful inside an organization: a personal item is shared by naming
 * people, and has no "everyone" to be opened to.
 */
export function parseContentVisibility(
    value: unknown,
    orgId: string | null | undefined,
):
    | { ok: true; visibility: ContentVisibility | undefined }
    | { ok: false; detail: string } {
    if (value === undefined || value === null)
        return { ok: true, visibility: undefined };
    if (!isContentVisibility(value))
        return {
            ok: false,
            detail: "visibility must be 'private' or 'organization'",
        };
    if (value === "organization" && !orgId)
        return {
            ok: false,
            detail: "Only an organization's item can be shared with the whole organization.",
        };
    return { ok: true, visibility: value };
}

/**
 * The caller's role on an organization's project or workflow, or null for no
 * access. The caller is already known to be a CURRENT member of that
 * organization; a non-member never reaches this.
 *
 *   1. the creator                                   -> owner
 *   2. an organization owner, when the item is
 *      public or has no Owner left                    -> owner
 *   3. a member it was shared with                   -> the role they were given
 *      (`deny` walls a member off, a public item included)
 *   4. everyone, when it is public                   -> editor
 *
 * An organization owner has no standing on a member's private item: private
 * is private. They take one over only when it is `ownerless` — its creator
 * has left the organization and nobody else was made an Owner — so the firm
 * never loses a matter and a departure never waits on a hand-over. The
 * database decides what is ownerless (isOrgItemOwnerless,
 * loadOwnerlessOrgItemIds); it is false for everything else.
 *
 * One function, because five read paths apply this rule (the single-item
 * checks, the accessible-project list, the document picker and the
 * organization's own resource list) and they must never disagree. It mirrors
 * the SQL project_access_role / workflow_access_role.
 */
export function resolveOrgContentRole(input: {
    isCreator: boolean;
    orgRole: OrgRole;
    override: OrgAccessOverrideRole | null | undefined;
    visibility: unknown;
    ownerless: boolean;
}): ProjectRole | null {
    if (input.isCreator) return "owner";
    if (
        isOrgOwner(input.orgRole) &&
        (input.visibility === "organization" || input.ownerless)
    )
        return "owner";
    if (input.override === "deny") return null;
    if (input.override) return input.override;
    return input.visibility === "organization" ? "editor" : null;
}

/**
 * Whether an organization's private project or workflow has no Owner left
 * among its current members, which is when its organization's owners take
 * it over. Asked of the database so the list RPCs and these checks reach
 * the same answer. Fails closed: an unanswered question is "no", and an
 * organization owner then has no more access than any other member.
 */
export async function isOrgItemOwnerless(
    db: Db,
    kind: "project" | "workflow",
    itemId: string,
): Promise<boolean> {
    const { data, error } = await db.rpc("org_item_is_ownerless", {
        p_kind: kind,
        p_item_id: itemId,
    });
    return !error && data === true;
}

/**
 * The private projects and workflows without an Owner in the given
 * organizations, for filters over many rows. Pass only the organizations
 * the caller OWNS: nobody else's verdict depends on it, and with none there
 * is nothing to ask. Fails closed, like isOrgItemOwnerless.
 */
export async function loadOwnerlessOrgItemIds(
    db: Db,
    ownedOrgIds: string[],
): Promise<{ projects: Set<string>; workflows: Set<string> }> {
    const ownerless = { projects: new Set<string>(), workflows: new Set<string>() };
    if (ownedOrgIds.length === 0) return ownerless;
    const { data, error } = await db.rpc("ownerless_org_item_ids", {
        p_org_ids: ownedOrgIds,
    });
    if (error || !Array.isArray(data)) return ownerless;
    for (const row of data as { kind?: unknown; item_id?: unknown }[]) {
        if (typeof row.item_id !== "string") continue;
        if (row.kind === "project") ownerless.projects.add(row.item_id);
        else if (row.kind === "workflow") ownerless.workflows.add(row.item_id);
    }
    return ownerless;
}

/** Normalize an email the way every grant/invitation row stores it. */
export function normalizeEmail(
    email: string | null | undefined,
): string | null {
    const normalized = (email ?? "").trim().toLowerCase();
    return normalized || null;
}

/**
 * The caller's role in a single org, or null if they are not a member.
 */
export async function getOrgRole(
    userId: string,
    orgId: string | null | undefined,
    db: Db,
): Promise<OrgRole | null> {
    if (!orgId) return null;
    const { data } = await db
        .from("org_members")
        .select("role, organizations!inner(id)")
        .is("organizations.deleted_at", null)
        .eq("org_id", orgId)
        .eq("user_id", userId)
        .maybeSingle();
    const role = (data as { role?: string } | null)?.role;
    return isOrgRole(role) ? role : null;
}

/**
 * The role a direct access grant gives the caller on a project, or null when
 * they hold no grant. Grants are keyed by normalized email so an invitation
 * to share can be honoured before the recipient has an account.
 */
export async function getProjectGrantRole(
    projectId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<ProjectRole | null> {
    const email = normalizeEmail(userEmail);
    if (!email) return null;
    const { data } = await db
        .from("project_access_grants")
        .select("role")
        .eq("project_id", projectId)
        .eq("email", email)
        .maybeSingle();
    const role = (data as { role?: string } | null)?.role;
    return isProjectRole(role) ? role : null;
}

/**
 * Choose the org_id a newly created resource should carry. Content created
 * inside a project inherits that project's org; everything else is personal
 * (org_id null). An absent org is still the personal case: the account's
 * personal organization exists, but nothing is filed under it yet.
 *
 * Result-shaped because "the lookup failed" and "this is personal" must
 * never share a value. `null` is not a safe default here: it is the very
 * encoding of personal content, and personal content is what account
 * deletion destroys. A swallowed error at this seam filed a firm's upload
 * as its uploader's private property — invisible to org inheritance today,
 * destroyed with the uploader's account later. Callers refuse the request
 * instead of guessing the tenant.
 */
export async function resolveContentOrgId(
    db: Db,
    params: { projectId?: string | null },
): Promise<{ ok: true; orgId: string | null } | { ok: false; detail: string }> {
    if (!params.projectId) return { ok: true, orgId: null };
    const { data, error } = await db
        .from("projects")
        .select("org_id")
        .eq("id", params.projectId)
        .maybeSingle();
    if (error)
        return {
            ok: false,
            detail:
                error.message ?? "Failed to resolve the project's organization",
        };
    if (!data)
        return {
            ok: false,
            detail: "Project not found",
        };
    return {
        ok: true,
        orgId: (data as { org_id?: string | null }).org_id ?? null,
    };
}

/**
 * The org_id for a chat or review started on its own, outside any project:
 * the organization whose workspace its author is working in, named by the
 * client as `org_id`, or null for Personal.
 *
 * The caller must belong to it. A person's own organization is not named
 * here: Personal is the absence of one.
 */
export async function resolveStandaloneOrgId(
    db: Db,
    params: { userId: string; orgId: unknown },
): Promise<{ ok: true; orgId: string | null } | { ok: false; detail: string }> {
    const { orgId } = params;
    if (orgId === undefined || orgId === null || orgId === "")
        return { ok: true, orgId: null };
    if (typeof orgId !== "string")
        return { ok: false, detail: "org_id must be a string" };
    const role = await getOrgRole(params.userId, orgId, db);
    if (!role || (await isPersonalOrg(db, orgId)))
        return {
            ok: false,
            detail: "You are not a member of that organization.",
        };
    return { ok: true, orgId };
}

type ProjectRow = {
    id: string;
    user_id: string | null;
    org_id?: string | null;
    visibility?: string | null;
};

export type ProjectAccess =
    | {
          ok: true;
          /** True when the caller created this row ("created by me"), which is
           *  provenance only — it grants no rights beyond the admin role the
           *  creator branch already derives. */
          isCreator: boolean;
          orgRole: OrgRole | null;
          projectRole: ProjectRole;
          project: ProjectRow;
      }
    | { ok: false };

export async function checkProjectAccess(
    projectId: string,
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<ProjectAccess> {
    const { data: project } = await db
        .from("projects")
        .select("id, user_id, org_id, visibility, archived_at")
        .eq("id", projectId)
        .maybeSingle();
    if (!project || project.archived_at) return { ok: false };
    const proj = project as ProjectRow;

    const isCreator = !!proj.user_id && proj.user_id === userId;

    // Organization scope is exclusive, and only a current member is in it:
    // somebody who has left the organization has no access, the creator
    // included. Inside it the project is private until shared or made public
    // (resolveOrgContentRole).
    if (proj.org_id) {
        const orgRole = await getOrgRole(userId, proj.org_id, db);
        if (!orgRole) return { ok: false };
        // The two verdicts that need nothing else read: the creator, and an
        // organization owner on a public project.
        if (
            isCreator ||
            (isOrgOwner(orgRole) && proj.visibility === "organization")
        )
            return {
                ok: true,
                isCreator,
                orgRole,
                projectRole: "owner",
                project: proj,
            };
        const override = await getOrgAccessOverrideRole(
            db,
            "project",
            proj.id,
            proj.org_id,
            userId,
        );
        // Fail closed: an unreadable override table must not admit a member
        // who may have been walled off.
        if (!override.ok) return { ok: false };
        let projectRole = resolveOrgContentRole({
            isCreator: false,
            orgRole,
            override: override.role,
            visibility: proj.visibility,
            // Only an organization owner's verdict on a private project
            // turns on this, so only then is it asked.
            ownerless:
                isOrgOwner(orgRole) && proj.visibility !== "organization"
                    ? await isOrgItemOwnerless(db, "project", proj.id)
                    : false,
        });
        if (
            !projectRole && isOrgAdmin(orgRole) &&
            await hasOrgPrivateContentAccess(db, proj.org_id, userId, "project", proj.id)
        ) projectRole = "viewer";
        if (!projectRole) return { ok: false };
        return {
            ok: true,
            isCreator: false,
            orgRole,
            projectRole,
            project: proj,
        };
    }

    const grantRole = await getProjectGrantRole(proj.id, userEmail, db);
    const projectRole = isCreator ? "owner" : grantRole;
    if (!projectRole) return { ok: false };
    return { ok: true, isCreator, orgRole: null, projectRole, project: proj };
}

/** A personal project is private only while it has no direct grants. */
export async function projectHasSharedAudience(
    db: Db,
    projectId: string,
    orgId: string | null | undefined,
): Promise<boolean> {
    if (orgId) return true;
    const { data, error } = await db
        .from("project_access_grants")
        .select("id")
        .eq("project_id", projectId)
        .limit(1);
    if (error) throw new Error("Failed to resolve project audience");
    return (data ?? []).length > 0;
}

type ResourceAccess =
    | {
          ok: true;
          isCreator: boolean;
          orgRole: OrgRole | null;
          projectRole: ProjectRole;
      }
    | { ok: false };

/**
 * Some operations stay scoped to the person who made the row — replacing or
 * deleting one version of a document, moving a review between projects.
 * Those rules are about authorship, not tier, and they predate this module.
 *
 * They acquired a hole the moment account deletion started blanking
 * `user_id` instead of destroying an organization's content: a row can now
 * have no creator at all, and "only the creator may act" then means NOBODY
 * may act. The document is stranded inside a project the organization is
 * supposed to control — exactly the outcome detaching the row was meant to
 * prevent. So when the creator is gone, the container's Owners inherit the
 * operation. While a creator still exists, nothing changes: an Owner does
 * not get to reach into a colleague's versions.
 */
export function creatorScopedAllowed(
    access: { isCreator: boolean; projectRole: ProjectRole },
    creatorId: string | null | undefined,
): boolean {
    if (access.isCreator) return true;
    return !creatorId && can(access.projectRole, "container.delete");
}

/** Build the ResourceAccess for a derived project role. */
function resourceAccessFor(
    projectRole: ProjectRole,
    orgRole: OrgRole | null,
    isCreator: boolean,
): ResourceAccess {
    return { ok: true, isCreator, orgRole, projectRole };
}

async function organizationResourceAccess(
    kind: OrgResourceKind,
    row: {
        id: string;
        user_id: string | null;
        org_id?: string | null;
        visibility?: string | null;
    },
    userId: string,
    db: Db,
): Promise<ResourceAccess> {
    if (!row.org_id) return { ok: false };
    const orgRole = await getOrgRole(userId, row.org_id, db);
    if (!orgRole) return { ok: false };
    const isCreator = !!row.user_id && row.user_id === userId;
    if (
        isCreator ||
        (isOrgOwner(orgRole) && row.visibility === "organization")
    )
        return resourceAccessFor("owner", orgRole, isCreator);
    const override = await getOrgAccessOverrideRole(
        db,
        kind,
        row.id,
        row.org_id,
        userId,
    );
    if (!override.ok) return { ok: false };
    let role = resolveOrgContentRole({
        isCreator: false,
        orgRole,
        override: override.role,
        visibility: row.visibility,
        ownerless:
            isOrgOwner(orgRole) && row.visibility !== "organization"
                ? await isOrgItemOwnerless(db, kind, row.id)
                : false,
    });
    if (
        !role && isOrgAdmin(orgRole) &&
        await hasOrgPrivateContentAccess(db, row.org_id, userId, kind, row.id)
    ) role = "viewer";
    return role ? resourceAccessFor(role, orgRole, false) : { ok: false };
}

type WorkflowRow = {
    id: string;
    user_id: string | null;
    org_id?: string | null;
    visibility?: string | null;
};

export type WorkflowAccess =
    | {
          ok: true;
          isCreator: boolean;
          orgRole: OrgRole | null;
          projectRole: ProjectRole;
          workflow: WorkflowRow;
      }
    | { ok: false };

/** Resolve a workflow through exactly one scope: organization or direct. */
export async function checkWorkflowAccess(
    workflowId: string,
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<WorkflowAccess> {
    const { data } = await db
        .from("workflows")
        .select("id, user_id, org_id, visibility, archived_at")
        .eq("id", workflowId)
        .maybeSingle();
    if (!data || data.archived_at) return { ok: false };
    const workflow = data as WorkflowRow;
    const isCreator = !!workflow.user_id && workflow.user_id === userId;

    if (workflow.org_id) {
        const access = await organizationResourceAccess(
            "workflow",
            workflow,
            userId,
            db,
        );
        return access.ok
            ? { ...access, workflow }
            : { ok: false };
    }

    if (isCreator)
        return {
            ok: true,
            isCreator: true,
            orgRole: null,
            projectRole: "owner",
            workflow,
        };
    const email = normalizeEmail(userEmail);
    if (!email) return { ok: false };
    // An exact match is correct because BOTH sides are canonical:
    // normalizeEmail trims and lowercases the caller's address, and
    // workflow_shares.shared_with_email carries a lowercase CHECK (added by
    // migration 20260917_01, which also folded the legacy mixed-case rows).
    // Before that constraint a mixed-case row listed for its recipient via
    // get_workflows_overview — which lowers both sides — and then missed
    // here, so the workflow 404'd the moment they opened it.
    const { data: share, error } = await db
        .from("workflow_shares")
        .select("role")
        .eq("workflow_id", workflowId)
        .eq("shared_with_email", email)
        .maybeSingle();
    if (error) return { ok: false };
    const role = (share as { role?: unknown } | null)?.role;
    if (!isProjectRole(role)) return { ok: false };
    return {
        ok: true,
        isCreator: false,
        orgRole: null,
        projectRole: role,
        workflow,
    };
}

/**
 * Check whether the current user can access a document the caller has
 * already loaded (saves a round-trip vs. having the helper re-fetch).
 * Project and workflow documents inherit their container role exactly.
 * `isCreator` remains row provenance: a project Owner is not the creator of a
 * colleague's document, while that colleague does not gain extra permissions
 * beyond the inherited container role.
 */
export async function ensureDocAccess(
    doc: {
        id?: string;
        user_id: string | null;
        project_id: string | null;
        org_id?: string | null;
        workflow_id?: string | null;
    },
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<ResourceAccess> {
    if (doc.project_id) {
        const access = await checkProjectAccess(
            doc.project_id,
            userId,
            userEmail,
            db,
        );
        return access.ok
            ? resourceAccessFor(
                  access.projectRole,
                  access.orgRole,
                  !!doc.user_id && doc.user_id === userId,
              )
            : { ok: false };
    }
    if (doc.workflow_id) {
        const access = await checkWorkflowAccess(
            doc.workflow_id,
            userId,
            userEmail,
            db,
        );
        return access.ok
            ? resourceAccessFor(
                  access.projectRole,
                  access.orgRole,
                  !!doc.user_id && doc.user_id === userId,
              )
            : { ok: false };
    }
    // A document that sits in no project or workflow has nothing to be
    // shared through: it is its uploader's alone, in Personal and in an
    // organization's workspace alike. The organization's owners have no
    // implicit access. Departure transfers referenced files or archives
    // unshared files. In a team organization the uploader must still be a member.
    const isCreator = !!doc.user_id && doc.user_id === userId;
    if (!isCreator) {
        return await hasOrgPrivateContentAccess(db, doc.org_id, userId, "document", doc.id)
            ? resourceAccessFor("viewer", null, false)
            : { ok: false };
    }
    const teamOrgId = await teamOrgIdOf(db, doc.org_id);
    if (!teamOrgId) return resourceAccessFor("owner", null, true);
    const orgRole = await getOrgRole(userId, teamOrgId, db);
    return orgRole
        ? resourceAccessFor("owner", orgRole, true)
        : { ok: false };
}

/**
 * Shared derivation for tabular reviews and assistant chats. Project children
 * inherit the project role exactly.
 *
 * A standalone row in a team organization belongs to that organization and
 * is private to its author: only current members reach it at all (its author
 * included), its author is its Owner, and a direct grant gives a member its
 * role. Organization owners have no implicit access. Unshared work is
 * archived when its final owner leaves and must be recovered before use.
 * public.standalone_org_access_role is the SQL twin.
 *
 * Any other standalone row is personal: its creator, and whoever it is
 * shared with by email.
 */
async function ensureSharedRowAccess(
    kind: ContentGrantKind,
    row: {
        id: string;
        user_id: string | null;
        project_id: string | null;
        org_id?: string | null;
    },
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<ResourceAccess> {
    if (row.project_id) {
        const access = await checkProjectAccess(
            row.project_id,
            userId,
            userEmail,
            db,
        );
        return access.ok
            ? resourceAccessFor(
                  access.projectRole,
                  access.orgRole,
                  !!row.user_id && row.user_id === userId,
              )
            : { ok: false };
    }
    const isCreator = !!row.user_id && row.user_id === userId;
    const orgId = await teamOrgIdOf(db, row.org_id);
    if (orgId) {
        const orgRole = await getOrgRole(userId, orgId, db);
        if (!orgRole) return { ok: false };
        if (isCreator) return resourceAccessFor("owner", orgRole, true);
        const granted = await getContentGrantRole(
            db,
            kind,
            row.id,
            userEmail,
        );
        const privateAccess = !granted && isOrgAdmin(orgRole)
            && await hasOrgPrivateContentAccess(db, orgId, userId, kind, row.id);
        return granted || privateAccess
            ? resourceAccessFor(granted || "viewer", orgRole, false)
            : { ok: false };
    }
    if (isCreator) return resourceAccessFor("owner", null, true);
    const role = await getContentGrantRole(
        db,
        kind,
        row.id,
        userEmail,
    );
    return role ? resourceAccessFor(role, null, false) : { ok: false };
}

/**
 * Same shape as `ensureDocAccess`, for tabular_reviews: creator, direct
 * grant, or inherited project access, using one exclusive scope.
 */
export async function ensureReviewAccess(
    review: {
        id: string;
        user_id: string | null;
        project_id: string | null;
        org_id?: string | null;
    },
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<ResourceAccess> {
    return ensureSharedRowAccess("tabular_review", review, userId, userEmail, db);
}

/**
 * Same shape as `ensureReviewAccess`, for assistant chats. A project chat
 * inherits the project verdict; a standalone chat is its author's, shared
 * through direct grants, in Personal or in the organization it was started
 * in.
 *
 * `get_chats_overview` mirrors this predicate branch for branch — keep the
 * two in lockstep, or a chat becomes openable by URL while staying invisible
 * in the list.
 */
export async function ensureChatAccess(
    chat: {
        id: string;
        user_id: string | null;
        project_id: string | null;
        org_id?: string | null;
    },
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<ResourceAccess> {
    return ensureSharedRowAccess("chat", chat, userId, userEmail, db);
}

/**
 * Filter user-supplied document IDs down to documents the caller can read.
 *
 * Tabular review routes accept document IDs from request bodies. Without this
 * check, a caller with access to any review could attach arbitrary document
 * UUIDs and later cause /generate or /regenerate-cell to extract those bytes.
 */
export async function filterAccessibleDocumentIds(
    documentIds: string[],
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<string[]> {
    if (documentIds.length === 0) return [];
    const { data: docs } = await db
        .from("documents")
        .select("id, user_id, project_id, workflow_id, org_id")
        .in("id", documentIds);
    const rows = (docs ?? []) as {
        id: string;
        user_id: string | null;
        project_id: string | null;
        workflow_id?: string | null;
        org_id?: string | null;
    }[];
    if (rows.length === 0) return [];

    const verdicts = await Promise.all(
        rows.map(async (doc) => ({
            id: doc.id,
            access: await ensureDocAccess(doc, userId, userEmail, db),
        })),
    );
    return verdicts.filter((entry) => entry.access.ok).map((entry) => entry.id);
}

const ACCESSIBLE_PROJECTS_PAGE_SIZE = 1000;
/** Guards a runaway loop, not a product limit. */
const ACCESSIBLE_PROJECTS_MAX_PAGES = 200;

/**
 * A read that fails is NOT an empty read. Every query in listAccessibleProjectIds
 * decides what the caller may see, and PostgREST answers a failed query with
 * `data: null` plus an `error` — which `?? []` used to turn into "no rows".
 * For the deny-override read that meant an unreadable override table (a
 * transient DB error, a statement timeout, a revoked grant) silently widened
 * the scope to every org project, including the walled ones; for a paged
 * scan it meant a firm silently lost every project past the failing page.
 * The picker (routes/projects.ts) already refuses on a denial-read error;
 * this helper now does the same, and its two callers handle the throw: the
 * audit query turns it into a 500 and the memory-archive job retries.
 */
function accessReadFailed(
    what: string,
    error: { message?: string | null } | null | undefined,
): Error {
    // The PostgREST error rides along as `cause` so a caller that logs it
    // still sees code/details/hint, not just this sentence.
    return new Error(
        `[listAccessibleProjectIds] ${what} failed: ${error?.message ?? "unknown error"}`,
        { cause: error ?? undefined },
    );
}

async function pageProjectRows<T>(
    fetchPage: (
        from: number,
        to: number,
    ) => PromiseLike<{
        data: T[] | null;
        error?: { message?: string | null } | null;
    }>,
    readDescription = "project page read",
): Promise<T[]> {
    const rows: T[] = [];
    for (let page = 0; page < ACCESSIBLE_PROJECTS_MAX_PAGES; page += 1) {
        const from = page * ACCESSIBLE_PROJECTS_PAGE_SIZE;
        const { data, error } = await fetchPage(
            from,
            from + ACCESSIBLE_PROJECTS_PAGE_SIZE - 1,
        );
        if (error) throw accessReadFailed(readDescription, error);
        const batch = (data ?? []) as T[];
        rows.push(...batch);
        if (batch.length < ACCESSIBLE_PROJECTS_PAGE_SIZE) return rows;
    }
    // Partial deny results are unsafe: an omitted denial looks like access.
    throw accessReadFailed(readDescription, {
        message: "Pagination limit reached",
    });
}

/**
 * Returns the set of project IDs the user can access — projects they created,
 * any project they hold an access grant on, and any project in an org they
 * belong to. Used to scope chat lists and similar collection queries.
 *
 * Written as bounded, paged project and override reads, and
 * deliberately not as `checkProjectAccess` per row. The previous shape issued
 * an unordered, unpaged `.in("org_id", …)` — silently truncated by PostgREST's
 * db-max-rows, so a large firm's audit trail simply lost the projects past the
 * cap — and then fanned out one verdict per org project, each of which is
 * itself two or three round trips. A firm with a few hundred matters paid
 * ~1000 sequential queries for one chat-list request. Paging by `id` (the
 * primary key, so the order is total and stable across pages) makes the reads
 * complete; re-deriving the org verdict inline from the same rules
 * checkProjectAccess applies makes them cheap.
 */
export async function listAccessibleProjectIds(
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<string[]> {
    const normalizedEmail = normalizeEmail(userEmail);

    // Roles decide ordinary sharing and eligibility for explicitly logged access.
    const { data: membershipRows, error: membershipError } = await db
        .from("org_members")
        .select("org_id, role, organizations!inner(id)")
        .is("organizations.deleted_at", null)
        .eq("user_id", userId);
    if (membershipError)
        throw accessReadFailed("org membership read", membershipError);
    const orgRoleByOrgId = new Map<string, string>();
    for (const row of (membershipRows ?? []) as {
        org_id?: string | null;
        role?: string | null;
    }[]) {
        if (row.org_id) orgRoleByOrgId.set(row.org_id, row.role ?? "");
    }
    const orgIds = [...orgRoleByOrgId.keys()];

    const { data: grants, error: grantsError } = normalizedEmail
        ? await db
              .from("project_access_grants")
              .select("project_id")
              .eq("email", normalizedEmail)
        : { data: [] as { project_id?: string | null }[], error: null };
    if (grantsError) throw accessReadFailed("access grant read", grantsError);
    const grantIds = [
        ...new Set(
            ((grants ?? []) as { project_id?: string | null }[])
                .map((grant) => grant.project_id)
                .filter((id): id is string => !!id),
        ),
    ];

    const [personalOwned, personalGranted, orgProjects, overrides] =
        await Promise.all([
            // Personal projects the caller created. Their ORG projects are
            // resolved by the org branch instead, because a creator who has
            // left the org no longer has access to them — exactly what
            // checkProjectAccess answers.
            pageProjectRows<{ id: string }>((from, to) =>
                db
                    .from("projects")
                    .select("id")
                    .eq("user_id", userId)
                    .is("org_id", null)
                    .order("id", { ascending: true })
                    .range(from, to),
            ),
            grantIds.length
                ? pageProjectRows<{ id: string }>((from, to) =>
                      db
                          .from("projects")
                          .select("id")
                          .in("id", grantIds)
                          .is("org_id", null)
                          .order("id", { ascending: true })
                          .range(from, to),
                  )
                : Promise.resolve([] as { id: string }[]),
            orgIds.length
                ? pageProjectRows<{
                      id: string;
                      user_id: string | null;
                      org_id: string;
                      visibility: string | null;
                  }>((from, to) =>
                      db
                          .from("projects")
                          .select("id, user_id, org_id, visibility, archived_at")
                          .in("org_id", orgIds)
                          .is("archived_at", null)
                          .order("id", { ascending: true })
                          .range(from, to),
                  )
                : Promise.resolve(
                      [] as {
                          id: string;
                          user_id: string | null;
                          org_id: string;
                          visibility: string | null;
                      }[],
                  ),
            // Every override the caller holds, not only the denials: in an
            // organization a project is private until shared, so a grant is
            // what ADMITS them as often as a denial is what excludes them.
            // Paged like the projects — a capped response would both drop
            // grants and admit walled matters beyond the first 1,000 rows.
            orgIds.length
                ? pageProjectRows<{ project_id: string; role: string }>(
                      (from, to) =>
                          db
                              .from("project_org_access_overrides")
                              .select("project_id, role")
                              .in("org_id", orgIds)
                              .eq("user_id", userId)
                              .order("project_id", { ascending: true })
                              .range(from, to),
                      "access override read",
                  )
                : Promise.resolve([] as { project_id: string; role: string }[]),
        ]);

    const overrideByProjectId = new Map(
        overrides.map((row) => [row.project_id, row.role]),
    );
    const ownerless = await loadOwnerlessOrgItemIds(
        db,
        orgIds.filter((orgId) => orgRoleByOrgId.get(orgId) === "owner"),
    );

    const privateAccess = await listOrgPrivateContentAccess(
        db,
        orgIds.filter(id => ["owner", "admin"].includes(orgRoleByOrgId.get(id) ?? "")),
        userId,
    );
    const ids = new Set<string>();
    for (const project of personalOwned) ids.add(project.id);
    for (const project of personalGranted) ids.add(project.id);
    for (const project of orgProjects) {
        // The same verdict checkProjectAccess reaches, re-derived inline.
        const orgRole = orgRoleByOrgId.get(project.org_id);
        if (!isOrgRole(orgRole)) continue;
        const override = overrideByProjectId.get(project.id);
        const role = resolveOrgContentRole({
            isCreator: !!project.user_id && project.user_id === userId,
            orgRole,
            override: isOrgAccessOverrideRole(override) ? override : null,
            visibility: project.visibility,
            ownerless: ownerless.projects.has(project.id),
        });
        if (role || privateAccess.get("project")?.has(project.id)) ids.add(project.id);
    }
    return [...ids];
}
