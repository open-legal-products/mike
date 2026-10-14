// workflows sharing — implementation behind the module facade.
import { type Db } from "../../lib/supabase";
import { findMissingUserEmails, loadProfileUsersByEmail } from "../../lib/userLookup";
import { type ProjectRole } from "../../lib/permissions";
import { deleteOrgAccessOverride, findAssignableOrgMember, isOrgAssignableRole, listOrgAccessPeople, setOrgAccessOverrides } from "../../lib/orgAccessOverrides";
import { resolveWorkflowAccess, resolveCreatorScopedWorkflow } from "./workflows.access";

export type ListSharesResult =
  | { ok: true; shares: unknown[] }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "db_error"; error: unknown };

export type ListWorkflowPeopleResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "db_error"; error: unknown };

// GET /workflows/:workflowId/people — the access roster any viewer of the
// workflow may read. Organization workflows answer from the org roster (with
// its overrides); personal ones answer from the direct-grant table.
/** Authorizes workflow access before returning its organization or direct-share roster and scoped profile photos. */
export async function listWorkflowPeople(
  db: Db,
  params: { workflowId: string; userId: string; userEmail: string | undefined },
): Promise<ListWorkflowPeopleResult> {
  const { workflowId, userId, userEmail } = params;
  const access = await resolveWorkflowAccess(db, workflowId, userId, userEmail);
  if (!access) return { ok: false, kind: "not_found" };

  const orgId = (access.workflow as { org_id?: string | null }).org_id ?? null;
  if (orgId) {
    const listed = await listOrgAccessPeople(db, {
      kind: "workflow",
      resourceId: workflowId,
      orgId,
      creatorId: access.workflow.user_id,
      visibility: access.workflow.visibility,
    });
    if (!listed.ok) return { ok: false, kind: "db_error", error: listed.detail };
    const creator = listed.people.find(
      (person) => person.user_id === access.workflow.user_id,
    );
    return {
      ok: true,
      body: {
        scope: "organization",
        owner: creator
          ? {
              user_id: creator.user_id,
              email: creator.email,
              display_name: creator.display_name,
              profile_photo: creator.profile_photo ?? null,
              role: "owner",
            }
          : null,
        members: listed.people.filter(
          (person) => person.user_id !== access.workflow.user_id,
        ),
      },
    };
  }

  const { data: shares, error } = await db
    .from("workflow_shares")
    .select("shared_with_email, role")
    .eq("workflow_id", workflowId);
  if (error) return { ok: false, kind: "db_error", error };
  const { userByEmail, userById } = await loadProfileUsersByEmail(db, {
    userIds: access.workflow.user_id ? [access.workflow.user_id] : [],
    emails: (shares ?? []).map((share) => share.shared_with_email as string),
  });
  const creator = access.workflow.user_id
    ? userById.get(access.workflow.user_id)
    : undefined;
  return {
    ok: true,
    body: {
      scope: "direct",
      owner: access.workflow.user_id
        ? {
            user_id: access.workflow.user_id,
            email: creator?.email ?? null,
            display_name: creator?.display_name ?? null,
            profile_photo: creator?.profile_photo ?? null,
            role: "owner",
          }
        : null,
      members: (
        (shares ?? []) as {
          shared_with_email: string;
          role: ProjectRole;
        }[]
      ).map((share) => ({
        email: share.shared_with_email,
        user_id: userByEmail.get(share.shared_with_email)?.id ?? null,
        profile_photo: userByEmail.get(share.shared_with_email)?.profile_photo ?? null,
        display_name:
          userByEmail.get(share.shared_with_email)?.display_name ?? null,
        role: share.role,
      })),
    },
  };
}

export async function listWorkflowShares(
  db: Db,
  params: { workflowId: string; userId: string; userEmail: string | undefined },
): Promise<ListSharesResult> {
  const { workflowId, userId, userEmail } = params;

  const wf = await resolveCreatorScopedWorkflow(
    db,
    workflowId,
    userId,
    userEmail,
  );
  if (!wf) return { ok: false, kind: "not_found" };

  const orgId = (wf as { org_id?: string | null }).org_id ?? null;
  if (orgId) {
    const listed = await listOrgAccessPeople(db, {
      kind: "workflow",
      resourceId: workflowId,
      orgId,
      creatorId: wf.user_id,
      visibility: wf.visibility,
    });
    if (!listed.ok) return { ok: false, kind: "db_error", error: listed.detail };
    return {
      ok: true,
      shares: listed.people
        .filter(
          (person) => person.user_id !== wf.user_id && person.has_override,
        )
        .map((person) => ({
          id: person.user_id,
          user_id: person.user_id,
          shared_with_email: person.email,
          display_name: person.display_name,
          role: person.role,
        })),
    };
  }

  const { data: shares, error } = await db
    .from("workflow_shares")
    .select("id, shared_with_email, role, created_at")
    .eq("workflow_id", workflowId)
    .order("created_at", { ascending: true });
  if (error) return { ok: false, kind: "db_error", error };

  return { ok: true, shares: shares ?? [] };
}

export async function deleteWorkflowShare(
  db: Db,
  params: {
    workflowId: string;
    shareId: string;
    userId: string;
    userEmail: string | undefined;
  },
): Promise<
  | { ok: true }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "share_not_found"; detail: string }
  | { ok: false; kind: "db_error"; error: unknown }
> {
  const { workflowId, shareId, userId, userEmail } = params;

  const wf = await resolveCreatorScopedWorkflow(
    db,
    workflowId,
    userId,
    userEmail,
  );
  if (!wf) return { ok: false, kind: "not_found" };

  const orgId = (wf as { org_id?: string | null }).org_id ?? null;
  if (orgId) {
    const result = await deleteOrgAccessOverride(db, {
      kind: "workflow",
      resourceId: workflowId,
      userId: shareId,
    });
    if (!result.ok) return { ok: false, kind: "db_error", error: result.detail };
    if (!result.removed)
      return {
        ok: false,
        kind: "share_not_found",
        detail: "Access override not found",
      };
  } else {
    // Read the result. Ignoring it made a failed delete and an unknown
    // share id indistinguishable from a real revocation: both answered
    // 204, so the client removed the row from its list while the person
    // it named kept access. Mirrors DELETE /projects/:id/access/:email.
    const { data: removed, error } = await db
      .from("workflow_shares")
      .delete()
      .eq("id", shareId)
      .eq("workflow_id", workflowId)
      .select("id");
    if (error) return { ok: false, kind: "db_error", error };
    if (((removed ?? []) as unknown[]).length === 0)
      return {
        ok: false,
        kind: "share_not_found",
        detail: "Access grant not found",
      };
  }
  return { ok: true };
}

export type ShareWorkflowResult =
  | { ok: true }
  | {
      ok: false;
      kind: "validation" | "self_share" | "missing_user";
      detail: string;
    }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "db_error"; error: unknown };

export async function shareWorkflow(
  db: Db,
  params: {
    workflowId: string;
    userId: string;
    userEmail: string | undefined;
    emails: string[];
    role: unknown;
  },
): Promise<ShareWorkflowResult> {
  const { workflowId, userId, userEmail, emails, role } = params;

  const normalizedEmails = [
    ...new Set(
      emails.map((email) => email.trim().toLowerCase()).filter(Boolean),
    ),
  ];
  if (normalizedEmails.length === 0) {
    return { ok: false, kind: "validation", detail: "emails is required" };
  }
  const normalizedUserEmail = userEmail?.trim().toLowerCase();
  if (normalizedUserEmail && normalizedEmails.includes(normalizedUserEmail)) {
    return {
      ok: false,
      kind: "self_share",
      detail: "You cannot share a workflow with yourself.",
    };
  }

  // Any effective Owner may manage access. Personal grants are stored by
  // normalized email and may only target an existing user; organization
  // overrides require a current organization member.
  const wf = await resolveCreatorScopedWorkflow(
    db,
    workflowId,
    userId,
    userEmail,
  );
  if (!wf) return { ok: false, kind: "not_found" };

  const orgId = (wf as { org_id?: string | null }).org_id ?? null;
  if (orgId) {
    if (!isOrgAssignableRole(role))
      return {
        ok: false,
        kind: "validation",
        detail: "role must be owner, editor, viewer or deny",
      };
    // Validate EVERY target before writing ANY override. Interleaving the
    // two loops meant a rejected third email — a non-member, the creator,
    // an admin — returned 400 with the first two overrides already
    // persisted: the caller read "nothing happened" while access had
    // silently changed for two people.
    const targets: { userId: string }[] = [];
    for (const email of normalizedEmails) {
      const target = await findAssignableOrgMember(
        db,
        orgId,
        email,
        wf.user_id,
        wf.visibility,
      );
      if (!target.ok) return target;
      targets.push({ userId: target.member.userId });
    }
    // Validation is complete, so only a database failure can still stop
    // this — and it must not stop it HALF WAY. One bulk upsert is one
    // statement: the org-membership triggers on the override table can
    // still refuse a row, and when they do the whole batch rolls back
    // instead of leaving the people ahead of the refusal already granted.
    const written = await setOrgAccessOverrides(db, {
      kind: "workflow",
      resourceId: workflowId,
      orgId,
      userIds: targets.map((target) => target.userId),
      role,
      assignedBy: userId,
    });
    if (!written.ok)
      return { ok: false, kind: "db_error", error: written.detail };
    return { ok: true };
  }

  if (role !== "owner" && role !== "editor" && role !== "viewer")
    return {
      ok: false,
      kind: "validation",
      detail: "role must be owner, editor or viewer",
    };

  let missingEmails: string[];
  try {
    missingEmails = await findMissingUserEmails(db, normalizedEmails);
  } catch (error) {
    return { ok: false, kind: "db_error", error };
  }
  if (missingEmails.length > 0)
    return {
      ok: false,
      kind: "missing_user",
      detail: `${missingEmails[0]} does not belong to a Mike user.`,
    };

  const rows = normalizedEmails.map((email: string) => ({
    workflow_id: workflowId,
    shared_by_user_id: userId,
    shared_with_email: email,
    role,
  }));
  // Upsert on (workflow_id, shared_with_email) so re-sharing to the same
  // person updates the existing row instead of stacking duplicates.
  const { error } = await db
    .from("workflow_shares")
    .upsert(rows, { onConflict: "workflow_id,shared_with_email" });
  if (error) return { ok: false, kind: "db_error", error };

  return { ok: true };
}
