// Who a playbook is shared with, for the people dialog. Mirrors
// workflows.sharing.ts: personal playbooks are shared by email, and an
// organization's with its members, who can also be denied a public one.
// Reading the roster needs view access; changing it needs Owner.

import { createServerSupabase, type Db } from "../../lib/supabase";
import {
  deleteOrgAccessOverride,
  findAssignableOrgMember,
  isOrgAssignableRole,
  listOrgAccessPeople,
  setOrgAccessOverrides,
} from "../../lib/orgAccessOverrides";
import { findMissingUserEmails, loadProfileUsersByEmail } from "../../lib/userLookup";
import { editablePlaybook, getPlaybook, PlaybookRequestError } from "./playbooks.operations";
import { type Playbook } from "./playbooks.types";
import type { PlaybookRole } from "./playbooks.access";

/** Playbook-specific roster rules; see playbooks.access.ts. */
function orgRoster(db: Db, playbook: Playbook) {
  return listOrgAccessPeople(db, {
    kind: "playbook",
    resourceId: playbook.id,
    orgId: playbook.orgId!,
    creatorId: playbook.userId,
    visibility: playbook.visibility,
    publicRole: "viewer",
    ownerlessTakeover: false,
  });
}

/** The access roster, in the shape the shared people dialog reads. */
export async function listPlaybookPeople(
  userId: string,
  userEmail: string | undefined,
  playbookId: string,
  db: Db = createServerSupabase(),
) {
  const playbook = await getPlaybook(userId, playbookId, db, userEmail);
  if (playbook.orgId) {
    const listed = await orgRoster(db, playbook);
    if (!listed.ok) throw new Error(listed.detail);
    // Who is walled off is for the playbook's owners to see.
    const people = playbook.canManageAccess
      ? listed.people
      : listed.people.filter((person) => person.role !== "deny");
    const creator = people.find((person) => person.user_id === playbook.userId);
    return {
      scope: "organization" as const,
      owner: creator
        ? {
            user_id: creator.user_id,
            email: creator.email,
            display_name: creator.display_name,
            profile_photo: creator.profile_photo ?? null,
            role: "owner" as const,
          }
        : null,
      members: people.filter((person) => person.user_id !== playbook.userId),
    };
  }

  const { data: shares, error } = await db
    .from("playbook_shares")
    .select("shared_with_email, role")
    .eq("playbook_id", playbookId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  const rows = (shares ?? []) as { shared_with_email: string; role: PlaybookRole }[];
  const { userByEmail, userById } = await loadProfileUsersByEmail(db, {
    userIds: [playbook.userId],
    emails: rows.map((share) => share.shared_with_email),
  });
  const creator = userById.get(playbook.userId);
  return {
    scope: "direct" as const,
    owner: {
      user_id: playbook.userId,
      email: creator?.email ?? null,
      display_name: creator?.display_name ?? null,
      profile_photo: creator?.profile_photo ?? null,
      role: "owner" as const,
    },
    members: rows.map((share) => {
      const person = userByEmail.get(share.shared_with_email);
      return {
        email: share.shared_with_email,
        user_id: person?.id ?? null,
        display_name: person?.display_name ?? null,
        profile_photo: person?.profile_photo ?? null,
        role: share.role,
      };
    }),
  };
}

export type PlaybookShare = {
  /** The grant's id; for an organization's playbook, the member's user id. */
  id: string;
  user_id?: string;
  shared_with_email: string;
  display_name?: string | null;
  role: PlaybookRole | "deny";
};

/** The grants themselves, for the playbook's owners. */
export async function listPlaybookShares(
  userId: string,
  userEmail: string | undefined,
  playbookId: string,
  db: Db = createServerSupabase(),
): Promise<PlaybookShare[]> {
  const playbook = await editablePlaybook(userId, playbookId, db, userEmail, "owner");
  if (playbook.orgId) {
    const listed = await orgRoster(db, playbook);
    if (!listed.ok) throw new Error(listed.detail);
    return listed.people
      .filter(
        (person) => person.user_id !== playbook.userId && person.has_override,
      )
      .map((person) => ({
        id: person.user_id,
        user_id: person.user_id,
        shared_with_email: person.email,
        display_name: person.display_name,
        role: person.role,
      }));
  }
  const { data, error } = await db
    .from("playbook_shares")
    .select("id, shared_with_email, role")
    .eq("playbook_id", playbookId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as PlaybookShare[];
}

/**
 * Give people a role. Re-sharing with someone changes their role. Every
 * target is checked before anything is written, so a refused address never
 * leaves the others half-shared.
 */
export async function sharePlaybook(
  userId: string,
  userEmail: string | undefined,
  playbookId: string,
  input: { emails: unknown; role: unknown },
  db: Db = createServerSupabase(),
): Promise<void> {
  const emails = Array.isArray(input.emails)
    ? [
        ...new Set(
          input.emails
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean),
        ),
      ]
    : [];
  if (!emails.length || emails.length > 50)
    throw new PlaybookRequestError("Add between 1 and 50 email addresses.");
  if (emails.some((email) => email.length > 320 || !email.includes("@")))
    throw new PlaybookRequestError("Use valid email addresses.");
  const self = userEmail?.trim().toLowerCase();
  if (self && emails.includes(self))
    throw new PlaybookRequestError("You cannot share a playbook with yourself.");

  const playbook = await editablePlaybook(userId, playbookId, db, userEmail, "owner");
  const role = input.role;

  if (playbook.orgId) {
    if (!isOrgAssignableRole(role))
      throw new PlaybookRequestError("Choose owner, editor, viewer or deny.");
    const targets: string[] = [];
    for (const email of emails) {
      const target = await findAssignableOrgMember(
        db,
        playbook.orgId,
        email,
        playbook.userId,
        playbook.visibility,
      );
      if (!target.ok) {
        if (target.kind === "db_error") throw target.error;
        throw new PlaybookRequestError(target.detail);
      }
      targets.push(target.member.userId);
    }
    // One statement, so a refusal from the database trigger rolls back the
    // whole batch.
    const written = await setOrgAccessOverrides(db, {
      kind: "playbook",
      resourceId: playbook.id,
      orgId: playbook.orgId,
      userIds: targets,
      role,
      assignedBy: userId,
    });
    if (!written.ok) throw new Error(written.detail);
    return;
  }

  if (role !== "owner" && role !== "editor" && role !== "viewer")
    throw new PlaybookRequestError("Choose owner, editor or viewer.");
  const missing = await findMissingUserEmails(db, emails);
  if (missing.length)
    throw new PlaybookRequestError(`${missing[0]} does not belong to a Mike user.`);
  const { error } = await db.from("playbook_shares").upsert(
    emails.map((email) => ({
      playbook_id: playbook.id,
      shared_by_user_id: userId,
      shared_with_email: email,
      role,
    })),
    { onConflict: "playbook_id,shared_with_email" },
  );
  if (error) throw error;
}

/** Remove one grant: a share id, or a member's user id in an organization. */
export async function revokePlaybookShare(
  userId: string,
  userEmail: string | undefined,
  playbookId: string,
  shareId: string,
  db: Db = createServerSupabase(),
): Promise<void> {
  const playbook = await editablePlaybook(userId, playbookId, db, userEmail, "owner");
  if (playbook.orgId) {
    const result = await deleteOrgAccessOverride(db, {
      kind: "playbook",
      resourceId: playbook.id,
      userId: shareId,
    });
    if (!result.ok) throw new Error(result.detail);
    if (!result.removed)
      throw new PlaybookRequestError("That person's access was not found.", 404);
    return;
  }
  // Read the result: a failed delete must not look like a revocation.
  const { data, error } = await db
    .from("playbook_shares")
    .delete()
    .eq("id", shareId)
    .eq("playbook_id", playbook.id)
    .select("id");
  if (error) throw error;
  if (!((data ?? []) as unknown[]).length)
    throw new PlaybookRequestError("That person's access was not found.", 404);
}
