// Personal organizations.
//
// Every account has an organization of its own (organizations.kind =
// 'personal'): one member, its owner, made with the account and removed with
// it. It is behind the scenes. Nothing a person does to "an organization" —
// list it, open its settings, rename it, invite into it, switch to it, file
// work under it by id — applies to it, and the places a client can name an
// organization ask here first, so that it reads as an organization that is
// not there.
//
// A database that has not yet run the migration has no `kind` column and no
// personal organizations; that reads as "not personal" rather than as a
// failure.

import type { Db } from "./supabase";

export const PERSONAL_ORG_KIND = "personal";

/** Whether an organizations row is somebody's personal organization. */
export function isPersonalOrgRow(row: unknown): boolean {
    return (row as { kind?: unknown } | null)?.kind === PERSONAL_ORG_KIND;
}

/** Postgres "undefined column", directly or as PostgREST reports it. */
function isMissingPersonalOrgSchema(error: {
    code?: string | null;
}): boolean {
    return error.code === "42703" || error.code === "PGRST204";
}

/**
 * Whether `orgId` is a personal organization. An id that names nothing is
 * not one.
 *
 * A read failure throws: answering "no" would let the request through to an
 * organization it must not reach.
 */
export async function isPersonalOrg(
    db: Db,
    orgId: string | null | undefined,
): Promise<boolean> {
    if (!orgId) return false;
    const { data, error } = await db
        .from("organizations")
        .select("kind")
        .eq("id", orgId)
        .maybeSingle();
    if (error) {
        if (isMissingPersonalOrgSchema(error)) return false;
        throw new Error("Failed to read the organization's kind");
    }
    return isPersonalOrgRow(data);
}

/**
 * `orgId` when it names a team organization, otherwise null: no
 * organization, or a person's own. Content filed under a team organization
 * follows the organization's rules; everything else follows the personal
 * ones.
 */
export async function teamOrgIdOf(
    db: Db,
    orgId: string | null | undefined,
): Promise<string | null> {
    if (!orgId) return null;
    return (await isPersonalOrg(db, orgId)) ? null : orgId;
}

/**
 * `teamOrgIdOf` for several organizations in one read: those of `orgIds`
 * that name a team organization.
 */
export async function teamOrgIdsAmong(
    db: Db,
    orgIds: (string | null | undefined)[],
): Promise<Set<string>> {
    const ids = [
        ...new Set(orgIds.filter((id): id is string => typeof id === "string")),
    ];
    if (ids.length === 0) return new Set();
    const { data, error } = await db
        .from("organizations")
        .select("id, kind")
        .in("id", ids);
    if (error) {
        if (isMissingPersonalOrgSchema(error)) return new Set(ids);
        throw new Error("Failed to read the organizations' kinds");
    }
    const personal = new Set(
        ((data ?? []) as { id?: string | null }[])
            .filter(isPersonalOrgRow)
            .map((row) => row.id),
    );
    return new Set(ids.filter((id) => !personal.has(id)));
}

/**
 * The ids of the personal organization(s) belonging to `userId` — one, once
 * the account has it.
 */
export async function listPersonalOrgIds(
    db: Db,
    userId: string,
): Promise<Set<string>> {
    const { data, error } = await db
        .from("organizations")
        .select("id")
        .eq("personal_user_id", userId);
    if (error) {
        if (isMissingPersonalOrgSchema(error)) return new Set();
        throw new Error("Failed to read the personal organization");
    }
    return new Set(
        ((data ?? []) as { id?: string | null }[])
            .map((row) => row.id)
            .filter((id): id is string => typeof id === "string"),
    );
}
