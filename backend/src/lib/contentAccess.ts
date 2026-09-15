// Direct, role-aware grants for assistant chats and tabular reviews.
//
// Both resources use the same access ladder as projects. Their creator has
// implicit Owner standing; these rows represent only additional recipients.

import type { Db } from "./supabase";
import { isProjectRole, type ProjectRole } from "./permissions";
import { findProfileUserByEmail } from "./userLookup";

const normalizeEmail = (email: string | null | undefined) => {
    const normalized = (email ?? "").trim().toLowerCase();
    return normalized || null;
};

export type ContentGrantKind = "chat" | "tabular_review";

const GRANT_CONFIG = {
    chat: {
        table: "chat_access_grants",
        resourceColumn: "chat_id",
        label: "chat",
    },
    tabular_review: {
        table: "tabular_review_access_grants",
        resourceColumn: "tabular_review_id",
        label: "tabular review",
    },
} as const;

export type ContentAccessGrant = {
    id: string;
    email: string;
    role: ProjectRole;
    created_by: string | null;
    created_at: string;
    updated_at: string;
    chat_id?: string;
    tabular_review_id?: string;
};

export type ContentGrantListResult =
  | { ok: true; grants: ContentAccessGrant[] }
  | { ok: false; detail: string };

/**
 * Whether a standalone resource has any collaborator. Creator provenance is
 * deliberately irrelevant: once a grant exists, every persisted response has
 * a shared audience even while the creator is the active actor.
 */
export async function hasDirectContentGrants(
  db: Db,
  kind: ContentGrantKind,
  resourceId: string,
): Promise<boolean> {
  const config = GRANT_CONFIG[kind];
  const { data, error } = await db
    .from(config.table)
    .select("id")
    .eq(config.resourceColumn, resourceId)
    .limit(1);
  if (error) {
    throw new Error(`Failed to resolve ${config.label} audience`);
  }
  return (data ?? []).length > 0;
}

export async function listContentGrants(
  db: Db,
  kind: ContentGrantKind,
    resourceId: string,
): Promise<ContentGrantListResult> {
    const config = GRANT_CONFIG[kind];
    const { data, error } = await db
        .from(config.table)
        .select("*")
        .eq(config.resourceColumn, resourceId)
        .order("created_at", { ascending: true });
    if (error)
        return {
            ok: false,
            detail: error.message ?? `Failed to load ${config.label} grants`,
        };
    return { ok: true, grants: (data ?? []) as ContentAccessGrant[] };
}

export async function getContentGrantRole(
    db: Db,
    kind: ContentGrantKind,
    resourceId: string,
    userEmail: string | null | undefined,
): Promise<ProjectRole | null> {
    const email = normalizeEmail(userEmail);
    if (!email) return null;
    const config = GRANT_CONFIG[kind];
    const { data } = await db
        .from(config.table)
        .select("role")
        .eq(config.resourceColumn, resourceId)
        .eq("email", email)
        .maybeSingle();
    return isProjectRole((data as { role?: unknown } | null)?.role)
        ? (data as { role: ProjectRole }).role
        : null;
}

export async function getContentGrantRoles(
    db: Db,
    kind: ContentGrantKind,
    resourceIds: string[],
    userEmail: string | null | undefined,
): Promise<Map<string, ProjectRole>> {
    const email = normalizeEmail(userEmail);
    if (!email || resourceIds.length === 0) return new Map();
    const config = GRANT_CONFIG[kind];
    const { data } = await db
        .from(config.table)
        .select(`${config.resourceColumn}, role`)
        .in(config.resourceColumn, resourceIds)
        .eq("email", email);
    const result = new Map<string, ProjectRole>();
    for (const row of (data ?? []) as Record<string, unknown>[]) {
        const id = row[config.resourceColumn];
        if (typeof id === "string" && isProjectRole(row.role))
            result.set(id, row.role);
    }
    return result;
}

export type ContentGrantWriteResult =
    | { ok: true; grant: ContentAccessGrant }
    | { ok: false; kind: "validation"; detail: string }
    | { ok: false; kind: "db_error"; detail: string };

export async function upsertContentGrant(
    db: Db,
    params: {
        kind: ContentGrantKind;
        resourceId: string;
        email: unknown;
        role: unknown;
        createdBy: string;
        creatorEmail?: string | null;
    },
): Promise<ContentGrantWriteResult> {
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
    const config = GRANT_CONFIG[params.kind];
    if (creatorEmail && creatorEmail === email)
        return {
            ok: false,
            kind: "validation",
            detail: `The ${config.label} creator already has owner access`,
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
                    : `Failed to verify ${config.label} grant recipient`,
        };
    }

    const { data, error } = await db
        .from(config.table)
        .upsert(
            {
                [config.resourceColumn]: params.resourceId,
                email,
                role: params.role,
                created_by: params.createdBy,
                updated_at: new Date().toISOString(),
            },
            { onConflict: `${config.resourceColumn},email` },
        )
        .select("*")
        .single();
    if (error || !data)
        return {
            ok: false,
            kind: "db_error",
            detail: error?.message ?? `Failed to save ${config.label} grant`,
        };
    return { ok: true, grant: data as ContentAccessGrant };
}

export async function deleteContentGrant(
    db: Db,
    params: {
        kind: ContentGrantKind;
        resourceId: string;
        email: string;
    },
): Promise<{ ok: true; removed: boolean } | { ok: false; detail: string }> {
    const email = normalizeEmail(params.email);
    if (!email) return { ok: true, removed: false };
    const config = GRANT_CONFIG[params.kind];
    const { data, error } = await db
        .from(config.table)
        .delete()
        .eq(config.resourceColumn, params.resourceId)
        .eq("email", email)
        .select("id");
    if (error) return { ok: false, detail: error.message };
    return { ok: true, removed: ((data ?? []) as unknown[]).length > 0 };
}

export async function removeContentGrantsForEmail(
    db: Db,
    email: string | null | undefined,
): Promise<void> {
    const normalized = normalizeEmail(email);
    if (!normalized) return;
    const results = await Promise.all(
        Object.values(GRANT_CONFIG).map((config) =>
            db.from(config.table).delete().eq("email", normalized),
        ),
    );
    const failed = results.find((result) => result.error)?.error;
    if (failed)
        throw new Error(
            `Failed to revoke content access grants: ${failed.message ?? "unknown error"}`,
        );
}
