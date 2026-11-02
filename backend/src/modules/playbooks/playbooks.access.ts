// Who may do what with a playbook. Matches workflows (owner, editor, viewer;
// organization members may be denied) with two differences:
//
//   - A public playbook gives every member the Viewer role, not Editor: its
//     rules are the organization's policy, so editing is granted per person.
//   - An organization's owners do not take over a private playbook whose
//     creator has left, and admins have no audited private access to one.
//
// This file must not import playbooks.operations.ts, which imports it.

import type { Db } from "../../lib/supabase";
import { isOrgOwner, normalizeEmail, type OrgRole } from "../../lib/access";
import {
  isOrgAccessOverrideRole,
  type OrgAccessOverrideRole,
} from "../../lib/orgAccessOverrides";
import type { ProjectRole } from "../../lib/permissions";

export type PlaybookRole = ProjectRole;

export type PlaybookAccessRow = {
  id: string;
  user_id: string;
  org_id: string | null;
  visibility: string | null;
};

const RANK: Record<PlaybookRole, number> = { viewer: 1, editor: 2, owner: 3 };

/** Whether `role` is at least `required`. */
export function hasPlaybookRole(
  role: PlaybookRole | null,
  required: PlaybookRole,
): boolean {
  return !!role && RANK[role] >= RANK[required];
}

/**
 * The caller's role on one playbook, or null for no access.
 *
 *   personal:      creator -> owner; a recipient -> the role they were given
 *   organization:  membership is required, even of the creator; then
 *                  creator -> owner; an organization owner on a public
 *                  playbook -> owner; deny -> none; an override -> its role;
 *                  a public playbook -> viewer; otherwise none
 */
export function resolvePlaybookRole(input: {
  isCreator: boolean;
  orgId: string | null;
  /** The caller's role in the playbook's organization; null if not a member. */
  orgRole: OrgRole | null;
  visibility: string | null;
  override: OrgAccessOverrideRole | null;
  directShare: PlaybookRole | null;
}): PlaybookRole | null {
  if (input.orgId) {
    if (!input.orgRole) return null;
    if (input.isCreator) return "owner";
    if (isOrgOwner(input.orgRole) && input.visibility === "organization")
      return "owner";
    if (input.override === "deny") return null;
    if (input.override) return input.override;
    return input.visibility === "organization" ? "viewer" : null;
  }
  if (input.isCreator) return "owner";
  return input.directShare;
}

function isPlaybookRole(value: unknown): value is PlaybookRole {
  return value === "owner" || value === "editor" || value === "viewer";
}

/**
 * Roles for many playbooks at once, for listings. `orgRoles` holds the
 * caller's role in each organization they belong to.
 */
export async function resolvePlaybookRoles(
  db: Db,
  rows: PlaybookAccessRow[],
  userId: string,
  email: string | null | undefined,
  orgRoles: ReadonlyMap<string, OrgRole>,
): Promise<Map<string, PlaybookRole>> {
  const ids = rows.map((row) => row.id);
  const normalized = normalizeEmail(email);
  const orgPlaybookIds = new Set(
    rows.flatMap((row) => (row.org_id ? [row.id] : [])),
  );
  const personalIds = ids.filter((id) => !orgPlaybookIds.has(id));
  const [overrides, shares] = await Promise.all([
    orgPlaybookIds.size
      ? db
          .from("playbook_org_access_overrides")
          .select("playbook_id, role")
          .eq("user_id", userId)
          .in("playbook_id", [...orgPlaybookIds])
      : { data: [], error: null },
    normalized && personalIds.length
      ? db
          .from("playbook_shares")
          .select("playbook_id, role")
          .eq("shared_with_email", normalized)
          .in("playbook_id", personalIds)
      : { data: [], error: null },
  ]);
  if (overrides.error) throw overrides.error;
  if (shares.error) throw shares.error;
  const overrideById = new Map<string, OrgAccessOverrideRole>();
  for (const row of (overrides.data ?? []) as { playbook_id: string; role: unknown }[])
    if (isOrgAccessOverrideRole(row.role))
      overrideById.set(String(row.playbook_id), row.role);
  const shareById = new Map<string, PlaybookRole>();
  for (const row of (shares.data ?? []) as { playbook_id: string; role: unknown }[])
    if (isPlaybookRole(row.role)) shareById.set(String(row.playbook_id), row.role);

  const roles = new Map<string, PlaybookRole>();
  for (const row of rows) {
    const role = resolvePlaybookRole({
      isCreator: row.user_id === userId,
      orgId: row.org_id,
      orgRole: row.org_id ? (orgRoles.get(row.org_id) ?? null) : null,
      visibility: row.visibility,
      override: overrideById.get(row.id) ?? null,
      directShare: shareById.get(row.id) ?? null,
    });
    if (role) roles.set(row.id, role);
  }
  return roles;
}

/**
 * Playbook ids the caller was given directly: by email for personal
 * playbooks, by organization override (not deny) for an organization's.
 */
export async function grantedPlaybookIds(
  db: Db,
  userId: string,
  email: string | null | undefined,
): Promise<string[]> {
  const normalized = normalizeEmail(email);
  const [overrides, shares] = await Promise.all([
    db
      .from("playbook_org_access_overrides")
      .select("playbook_id, role")
      .eq("user_id", userId),
    normalized
      ? db
          .from("playbook_shares")
          .select("playbook_id")
          .eq("shared_with_email", normalized)
      : { data: [], error: null },
  ]);
  if (overrides.error) throw overrides.error;
  if (shares.error) throw shares.error;
  return [
    ...new Set([
      ...((overrides.data ?? []) as { playbook_id: string; role: string }[])
        .filter((row) => row.role !== "deny")
        .map((row) => String(row.playbook_id)),
      ...((shares.data ?? []) as { playbook_id: string }[]).map((row) =>
        String(row.playbook_id),
      ),
    ]),
  ];
}

/**
 * The people a playbook is shared with, as email addresses, for its owners'
 * listings. Personal playbooks list their recipients; an organization's
 * lists members with a role other than deny.
 */
export async function playbookRecipientEmails(
  db: Db,
  rows: PlaybookAccessRow[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (!rows.length) return result;
  const orgPlaybookIds = rows.filter((row) => row.org_id).map((row) => row.id);
  const personalIds = rows.filter((row) => !row.org_id).map((row) => row.id);
  const [shares, overrides] = await Promise.all([
    personalIds.length
      ? db
          .from("playbook_shares")
          .select("playbook_id, shared_with_email")
          .in("playbook_id", personalIds)
      : { data: [], error: null },
    orgPlaybookIds.length
      ? db
          .from("playbook_org_access_overrides")
          .select("playbook_id, user_id, role")
          .in("playbook_id", orgPlaybookIds)
      : { data: [], error: null },
  ]);
  if (shares.error) throw shares.error;
  if (overrides.error) throw overrides.error;
  const add = (id: string, email: string) =>
    result.set(id, [...(result.get(id) ?? []), email]);
  for (const row of (shares.data ?? []) as {
    playbook_id: string;
    shared_with_email: string;
  }[])
    add(String(row.playbook_id), String(row.shared_with_email));
  const granted = ((overrides.data ?? []) as {
    playbook_id: string;
    user_id: string;
    role: string;
  }[]).filter((row) => row.role !== "deny");
  if (granted.length) {
    const { data: profiles, error } = await db
      .from("user_profiles")
      .select("user_id, email")
      .in("user_id", [...new Set(granted.map((row) => row.user_id))]);
    if (error) throw error;
    const emailById = new Map(
      ((profiles ?? []) as { user_id: string; email: string | null }[]).map(
        (profile) => [profile.user_id, profile.email],
      ),
    );
    for (const row of granted) {
      const email = emailById.get(row.user_id);
      if (email) add(String(row.playbook_id), email);
    }
  }
  return result;
}
