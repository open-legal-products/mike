// Direct access grants for a project.
//
// Sharing is an Owner power (`access.manage`). Personal projects use direct
// email grants; organization projects use organization-member overrides.
// The two shapes are deliberately kept apart here rather than merged into one
// "grant" concept: an org override names a member who already exists, while a
// direct grant addresses an email that may not have an account yet.

import {
  checkProjectAccess,
  normalizeEmail,
} from "../../lib/access";
import { can } from "../../lib/permissions";
import {
  deleteProjectGrant,
  listProjectGrants,
  upsertProjectGrant,
} from "../../lib/projectAccess";
import {
  deleteOrgAccessOverride,
  findOrgMemberByEmail,
  findAssignableOrgMember,
  isOrgAssignableRole,
  listOrgAccessPeople,
  setOrgAccessOverride,
} from "../../lib/orgAccessOverrides";
import { type Db } from "./projects.shared";

// Every refusal the three handlers below can produce. `db_error` carries the
// raw driver detail: the route hands it to sendInternalError, which logs it
// and answers with the generic body, so no driver message reaches a client.
export type ProjectAccessFailure =
  | { ok: false; kind: "not_found"; detail: string }
  | { ok: false; kind: "forbidden"; detail: string }
  | { ok: false; kind: "validation"; detail: string }
  | { ok: false; kind: "db_error"; error: unknown };

const NOT_FOUND: ProjectAccessFailure = {
  ok: false,
  kind: "not_found",
  detail: "Project not found",
};

const CANNOT_MANAGE: ProjectAccessFailure = {
  ok: false,
  kind: "forbidden",
  detail: "Only a project owner can change who has access.",
};

// GET /projects/:projectId/access — the grant list, for whoever may manage
// it. This is the management surface: each row carries who granted it and
// when, and its one consumer is the People modal's role pickers, which only
// render for Owners. Serving it at mere reachability let any Viewer — the
// outside-counsel tier — enumerate every recipient, role and grantor on the
// matter.
export async function listProjectAccess(
  db: Db,
  args: { projectId: string; userId: string; userEmail?: string },
): Promise<
  { ok: true; body: Record<string, unknown> } | ProjectAccessFailure
> {
  const { projectId, userId, userEmail } = args;

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return NOT_FOUND;
  if (!can(access.projectRole, "access.manage")) return CANNOT_MANAGE;
  if (access.project.org_id) {
    const listed = await listOrgAccessPeople(db, {
      kind: "project",
      resourceId: projectId,
      orgId: access.project.org_id,
      creatorId: access.project.user_id,
    });
    if (!listed.ok) return { ok: false, kind: "db_error", error: listed.detail };
    return {
      ok: true,
      body: {
        scope: "organization",
        org_id: access.project.org_id,
        access_role: access.projectRole,
        grants: listed.people.filter(
          (person) =>
            person.user_id !== access.project.user_id && person.has_override,
        ),
      },
    };
  }
  const listed = await listProjectGrants(db, projectId);
  if (!listed.ok) return { ok: false, kind: "db_error", error: listed.detail };
  return {
    ok: true,
    body: {
      scope: "direct",
      org_id: access.project.org_id ?? null,
      access_role: access.projectRole,
      grants: listed.grants,
    },
  };
}

// POST /projects/:projectId/access — grant or re-role one recipient.
export async function grantProjectAccess(
  db: Db,
  args: {
    projectId: string;
    userId: string;
    userEmail?: string;
    body: { email?: unknown; role?: unknown };
  },
): Promise<
  { ok: true; grant: Record<string, unknown> } | ProjectAccessFailure
> {
  const { projectId, userId, userEmail, body } = args;

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return NOT_FOUND;
  if (!can(access.projectRole, "access.manage")) return CANNOT_MANAGE;

  const role = body?.role;
  const email = normalizeEmail(
    typeof body?.email === "string" ? body.email : null,
  );
  if (email && normalizeEmail(userEmail) === email)
    return {
      ok: false,
      kind: "validation",
      detail: "You cannot share a project with yourself.",
    };

  if (access.project.org_id) {
    if (!email)
      return {
        ok: false,
        kind: "validation",
        detail: "A valid email address is required",
      };
    if (!isOrgAssignableRole(role))
      return {
        ok: false,
        kind: "validation",
        detail: "role must be owner, editor, viewer or deny",
      };
    const target = await findAssignableOrgMember(
      db, access.project.org_id, email, access.project.user_id,
    );
    if (!target.ok) return target;
    const result = await setOrgAccessOverride(db, {
      kind: "project",
      resourceId: projectId,
      orgId: access.project.org_id,
      userId: target.member.userId,
      role,
      assignedBy: userId,
    });
    if (!result.ok) return { ok: false, kind: "db_error", error: result.detail };
    return {
      ok: true,
      grant: {
        user_id: target.member.userId,
        email: target.member.email,
        role,
      },
    };
  }

  if (role === "deny")
    return {
      ok: false,
      kind: "validation",
      detail: "Deny is only available for organization members",
    };
  const creatorProfile = access.project.user_id
    ? await db
        .from("user_profiles")
        .select("email")
        .eq("user_id", access.project.user_id)
        .maybeSingle()
    : null;
  const result = await upsertProjectGrant(db, {
    projectId,
    email: body?.email,
    role,
    createdBy: userId,
    creatorEmail:
      (creatorProfile?.data as { email?: string | null } | null)?.email ?? null,
  });
  if (!result.ok) {
    if (result.kind === "validation")
      return { ok: false, kind: "validation", detail: result.detail };
    // result.detail is a raw driver message here — log it, never send it.
    return { ok: false, kind: "db_error", error: result.detail };
  }
  return { ok: true, grant: result.grant as unknown as Record<string, unknown> };
}

// DELETE /projects/:projectId/access/:email — revoke one recipient.
export async function revokeProjectAccess(
  db: Db,
  args: {
    projectId: string;
    userId: string;
    userEmail?: string;
    targetEmail: string;
  },
): Promise<{ ok: true } | ProjectAccessFailure> {
  const { projectId, userId, userEmail, targetEmail } = args;

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return NOT_FOUND;
  if (!can(access.projectRole, "access.manage")) return CANNOT_MANAGE;

  if (access.project.org_id) {
    const email = normalizeEmail(targetEmail);
    if (!email)
      return {
        ok: false,
        kind: "not_found",
        detail: "Access override not found",
      };
    const target = await findOrgMemberByEmail(
      db,
      access.project.org_id,
      email,
    );
    if (!target.ok) {
      if (target.kind === "not_found")
        return {
          ok: false,
          kind: "not_found",
          detail: "Access override not found",
        };
      return { ok: false, kind: "db_error", error: target.detail };
    }
    const result = await deleteOrgAccessOverride(db, {
      kind: "project",
      resourceId: projectId,
      userId: target.member.userId,
    });
    if (!result.ok) return { ok: false, kind: "db_error", error: result.detail };
    if (!result.removed)
      return {
        ok: false,
        kind: "not_found",
        detail: "Access override not found",
      };
    return { ok: true };
  }

  const result = await deleteProjectGrant(db, {
    projectId,
    email: targetEmail,
  });
  if (!result.ok) return { ok: false, kind: "db_error", error: result.detail };
  if (!result.removed)
    return { ok: false, kind: "not_found", detail: "Access grant not found" };
  return { ok: true };
}
