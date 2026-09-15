// Direct (non-organization) access grants on a project.
//
// The original model was `projects.shared_with`, a jsonb array of emails. It
// could express WHO but never WHAT: every collaborator got the same rights,
// so "let outside counsel read this" and "let a colleague restructure it"
// were the same operation. `project_access_grants` replaces it with one row
// per recipient carrying an explicit project role.
//
// Two properties are load-bearing:
//
//   * Grants are keyed by normalized email, not user id. A recipient must have
//     an existing profile when the grant is created; email remains the stable
//     address used when evaluating access.
//   * Direct grants and organization access are mutually exclusive scopes.
//     Organization content instead uses membership defaults plus explicit
//     per-resource overrides.
//
// The retired `projects.shared_with` array is migrated once into this table;
// all reads and writes use grants directly from then on.

import type { Db } from "./supabase";
import { normalizeEmail } from "./access";
import { isProjectRole, type ProjectRole } from "./permissions";
import { listOrgAccessPeople } from "./orgAccessOverrides";
import { findProfileUserByEmail } from "./userLookup";

export type ProjectGrant = {
    id: string;
    project_id: string;
    email: string;
    role: ProjectRole;
    created_by: string | null;
    created_at: string;
    updated_at: string;
};

export async function listProjectPeople(
    db: Db,
    project: { id: string; user_id: string | null; org_id?: string | null },
): Promise<
    | {
          ok: true;
          scope: "direct" | "organization";
          owner: {
              user_id: string;
              email: string | null;
              display_name: string | null;
              role: "owner";
          } | null;
          members: {
              user_id?: string | null;
              email: string;
              display_name: string | null;
              role: ProjectRole | "deny";
          }[];
      }
    | { ok: false; detail: string }
> {
    if (project.org_id) {
        const listed = await listOrgAccessPeople(db, {
            kind: "project",
            resourceId: project.id,
            orgId: project.org_id,
            creatorId: project.user_id,
        });
        if (!listed.ok) return listed;
        const creator = listed.people.find(
            (person) => person.user_id === project.user_id,
        );
        return {
            ok: true,
            scope: "organization",
            owner: creator
                ? {
                      user_id: creator.user_id,
                      email: creator.email,
                      display_name: creator.display_name,
                      role: "owner",
                  }
                : null,
            members: listed.people.filter(
                (person) => person.user_id !== project.user_id,
            ),
        };
    }

    const [listed, creatorProfile] = await Promise.all([
        listProjectGrants(db, project.id),
        project.user_id
            ? db
                  .from("user_profiles")
                  .select("user_id, email, display_name")
                  .eq("user_id", project.user_id)
                  .maybeSingle()
            : Promise.resolve({ data: null, error: null }),
    ]);
    if (!listed.ok) return listed;
    if (creatorProfile.error)
        return { ok: false, detail: creatorProfile.error.message };
    const emails = listed.grants.map((grant) => grant.email);
    const { data: profiles, error } = emails.length
        ? await db
              .from("user_profiles")
              .select("user_id, email, display_name")
              .in("email", emails)
        : { data: [], error: null };
    if (error) return { ok: false, detail: error.message };
    const profileByEmail = new Map(
        ((profiles ?? []) as {
            user_id: string;
            email: string;
            display_name: string | null;
        }[]).map((profile) => [profile.email, profile]),
    );
    const creator = creatorProfile.data as {
        user_id: string;
        email: string | null;
        display_name: string | null;
    } | null;
    return {
        ok: true,
        scope: "direct",
        owner: creator
            ? {
                  user_id: creator.user_id,
                  email: creator.email,
                  display_name: creator.display_name,
                  role: "owner",
              }
            : null,
        members: listed.grants.map((grant) => ({
            user_id: profileByEmail.get(grant.email)?.user_id ?? null,
            email: grant.email,
            display_name:
                profileByEmail.get(grant.email)?.display_name ?? null,
            role: grant.role,
        })),
    };
}

export type GrantListResult =
    | { ok: true; grants: ProjectGrant[] }
    | { ok: false; detail: string };

/**
 * Result-shaped on purpose: a failed read and an empty grant table are
 * different answers. Callers use this result for access-management UI and
 * administrator contacts, so every caller must distinguish "none" from
 * "could not load".
 */
export async function listProjectGrants(
    db: Db,
    projectId: string,
): Promise<GrantListResult> {
    const { data, error } = await db
        .from("project_access_grants")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: true });
    if (error)
        return {
            ok: false,
            detail: error.message ?? "Failed to load access grants",
        };
    return { ok: true, grants: (data ?? []) as ProjectGrant[] };
}

export type GrantWriteResult =
    | { ok: true; grant: ProjectGrant }
    | { ok: false; kind: "validation"; detail: string }
    | { ok: false; kind: "db_error"; detail: string };

/**
 * Create or re-role one recipient. Upsert rather than insert-or-409: sharing
 * again with a different role is the natural way a user changes someone's
 * access, and making that a conflict would force the UI to guess which verb
 * to send.
 */
export async function upsertProjectGrant(
    db: Db,
    params: {
        projectId: string;
        email: unknown;
        role: unknown;
        createdBy: string;
        /** Emails belonging to the project's creator can't be granted away. */
        creatorEmail?: string | null;
    },
): Promise<GrantWriteResult> {
    const email =
        typeof params.email === "string" ? normalizeEmail(params.email) : null;
    if (!email || !email.includes("@"))
        return {
            ok: false,
            kind: "validation",
            detail: "A valid email address is required",
        };
    if (!isProjectRole(params.role))
        return {
            ok: false,
            kind: "validation",
            detail: "role must be owner, editor or viewer",
        };
    const creatorEmail = normalizeEmail(params.creatorEmail);
    if (creatorEmail && creatorEmail === email)
        return {
            ok: false,
            kind: "validation",
            detail: "The project creator already has owner access",
        };

    try {
        const recipient = await findProfileUserByEmail(db, email);
        if (!recipient)
            return {
                ok: false,
                kind: "validation",
                detail: `${email} does not belong to a Mike user.`,
            };
    } catch (error) {
        return {
            ok: false,
            kind: "db_error",
            detail:
                error && typeof error === "object" && "message" in error
                    ? String(error.message)
                    : "Failed to verify access grant recipient",
        };
    }

    const { data, error } = await db
        .from("project_access_grants")
        .upsert(
            {
                project_id: params.projectId,
                email,
                role: params.role,
                created_by: params.createdBy,
                updated_at: new Date().toISOString(),
            },
            { onConflict: "project_id,email" },
        )
        .select("*")
        .single();
    if (error || !data)
        return {
            ok: false,
            kind: "db_error",
            detail: error?.message ?? "Failed to save access grant",
        };
    return { ok: true, grant: data as ProjectGrant };
}

export async function deleteProjectGrant(
    db: Db,
    params: { projectId: string; email: string },
): Promise<{ ok: true; removed: boolean } | { ok: false; detail: string }> {
    const email = normalizeEmail(params.email);
    if (!email) return { ok: true, removed: false };
    const { data, error } = await db
        .from("project_access_grants")
        .delete()
        .eq("project_id", params.projectId)
        .eq("email", email)
        .select("id");
    if (error) return { ok: false, detail: error.message };
    return { ok: true, removed: ((data ?? []) as unknown[]).length > 0 };
}

export type ProjectContact = {
    user_id: string | null;
    email: string | null;
    display_name: string | null;
    /** How this person got Owner access: creator, grant or organization. */
    source: "creator" | "grant" | "organization";
};

/**
 * Everyone who can administer this project, with an address to contact them.
 *
 * The UI needs this to answer "you can't do that — ask who?" A permission
 * popup that has no name to offer is a dead end, and the previous shape made
 * that unavoidable: GET /projects/:id returned no contact at all, and the
 * overview RPC's owner_email column is a literal NULL, so the popup's email
 * line could never render.
 *
 * The creator is listed first (they are the most likely point of contact),
 * followed by direct Owner grants or the org's Admins.
 */
export async function listProjectAdminContacts(
    db: Db,
    project: { id: string; user_id: string | null; org_id?: string | null },
): Promise<ProjectContact[]> {
    const contacts: ProjectContact[] = [];
    const seenEmails = new Set<string>();
    const push = (contact: ProjectContact) => {
        const key = contact.email ?? `id:${contact.user_id}`;
        if (!key || seenEmails.has(key)) return;
        seenEmails.add(key);
        contacts.push(contact);
    };

    if (project.org_id) {
        const listed = await listOrgAccessPeople(db, {
            kind: "project",
            resourceId: project.id,
            orgId: project.org_id,
            creatorId: project.user_id,
        });
        if (!listed.ok) {
            console.error("[project-access] organization roster unreadable", {
                projectId: project.id,
                message: listed.detail,
            });
            return [];
        }
        for (const person of listed.people) {
            if (person.role !== "owner") continue;
            push({
                user_id: person.user_id,
                email: person.email,
                display_name: person.display_name,
                source:
                    person.user_id === project.user_id
                        ? "creator"
                        : "organization",
            });
        }
        return contacts;
    }

    const profileIds: string[] = [];
    let creatorIsActive = !!project.user_id;

    // Contacts are enrichment for refusal popups, not an authorization
    // input, so a failed grants read degrades this one source rather than
    // failing the project load — the creator and org-admin contacts below
    // are still built. Logged because a popup with no name is a dead end.
    const listed = project.org_id
        ? ({ ok: true, grants: [] } as const)
        : await listProjectGrants(db, project.id);
    if (!listed.ok) {
        console.error("[project-access] grants unreadable for contacts", {
            projectId: project.id,
            message: listed.detail,
        });
    }
    const adminGrantEmails = (listed.ok ? listed.grants : [])
        .filter((g) => g.role === "owner")
        .map((g) => g.email);

    let orgOwnerIds: string[] = [];
    if (project.org_id) {
        const [{ data: membership }, { data: overrides }] = await Promise.all([
            project.user_id
                ? db
                      .from("org_members")
                      .select("user_id")
                      .eq("org_id", project.org_id)
                      .eq("user_id", project.user_id)
                      .maybeSingle()
                : Promise.resolve({ data: null }),
            db
            .from("project_org_access_overrides")
            .select("user_id")
            .eq("project_id", project.id)
            .eq("role", "owner"),
        ]);
        creatorIsActive = !!membership;
        orgOwnerIds = ((overrides ?? []) as { user_id?: string | null }[])
            .map((r) => r.user_id)
            .filter((id): id is string => !!id);
        profileIds.push(...orgOwnerIds);
    }
    if (creatorIsActive && project.user_id) profileIds.push(project.user_id);

    const byUserId = new Map<
        string,
        { email: string | null; display_name: string | null }
    >();
    const byEmail = new Map<
        string,
        { user_id: string; display_name: string | null }
    >();
    if (profileIds.length > 0) {
        const { data } = await db
            .from("user_profiles")
            .select("user_id, email, display_name")
            .in("user_id", [...new Set(profileIds)]);
        for (const p of (data ?? []) as {
            user_id: string;
            email: string | null;
            display_name: string | null;
        }[]) {
            byUserId.set(p.user_id, {
                email: p.email ?? null,
                display_name: p.display_name ?? null,
            });
        }
    }
    if (adminGrantEmails.length > 0) {
        const { data } = await db
            .from("user_profiles")
            .select("user_id, email, display_name")
            .in("email", adminGrantEmails);
        for (const p of (data ?? []) as {
            user_id: string;
            email: string | null;
            display_name: string | null;
        }[]) {
            if (p.email) byEmail.set(p.email, {
                user_id: p.user_id,
                display_name: p.display_name ?? null,
            });
        }
    }

    if (creatorIsActive && project.user_id) {
        const profile = byUserId.get(project.user_id);
        push({
            user_id: project.user_id,
            email: profile?.email ?? null,
            display_name: profile?.display_name ?? null,
            source: "creator",
        });
    }
    for (const email of adminGrantEmails) {
        const profile = byEmail.get(email);
        push({
            user_id: profile?.user_id ?? null,
            email,
            display_name: profile?.display_name ?? null,
            source: "grant",
        });
    }
    for (const ownerId of orgOwnerIds) {
        const profile = byUserId.get(ownerId);
        push({
            user_id: ownerId,
            email: profile?.email ?? null,
            display_name: profile?.display_name ?? null,
            source: "organization",
        });
    }
    return contacts;
}

/**
 * Drop every grant addressed to one person (account deletion).
 *
 * Throws on failure: the caller is the account-deletion sequence, which
 * already propagates errors into an honest 500 so the deletion can be
 * retried. Swallowing this delete meant an account could be erased while
 * its grants stayed live — access held by an address whose person is gone.
 */
export async function removeGrantsForEmail(
    db: Db,
    email: string | null | undefined,
): Promise<void> {
    const normalized = normalizeEmail(email);
    if (!normalized) return;
    const { error } = await db
        .from("project_access_grants")
        .delete()
        .eq("email", normalized);
    if (error)
        throw new Error(
            `Failed to revoke access grants: ${error.message ?? "unknown error"}`,
        );
}
