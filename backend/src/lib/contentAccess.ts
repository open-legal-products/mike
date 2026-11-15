// Direct, role-aware grants for assistant chats and tabular reviews.
//
// Both resources use the same access ladder as projects. Their creator has
// implicit Owner standing; these rows represent only additional recipients.

import type { Db } from "./supabase";
import { isProjectRole, type ProjectRole } from "./permissions";
import { findProfileUserByEmail } from "./userLookup";
import {
    cancelPendingShare,
    createPendingShares,
    planDirectShare,
    type PendingGrantView,
} from "./shareInvitations";

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

export type ContentGrantWriteResult =
    | { ok: true; grant: ContentAccessGrant | PendingGrantView }
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
        createdByEmail?: string | null;
        creatorEmail?: string | null;
        /**
         * The team organization the resource belongs to, when it belongs to
         * one. Its content is never shared outside it, so the recipient must
         * be one of its members.
         */
        orgId?: string | null;
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
        if (params.orgId) {
            // An organization's content is shared only with its members.
            // "No account" and "not a member" get the same answer, so the
            // refusal says nothing about anyone outside the organization.
            const recipient = await findProfileUserByEmail(db, email);
            const { data: membership, error: membershipError } = recipient
                ? await db
                      .from("org_members")
                      .select("role")
                      .eq("org_id", params.orgId)
                      .eq("user_id", recipient.id)
                      .maybeSingle()
                : { data: null, error: null };
            if (membershipError) throw membershipError;
            if (!membership)
                return {
                    ok: false,
                    kind: "validation",
                    detail: `${email} is not a member of this organization.`,
                };
        } else {
            const plan = await planDirectShare(db, {
                kind: params.kind,
                resourceId: params.resourceId,
                sharerId: params.createdBy,
                emails: [email],
            });
            if (!plan.ok) throw new Error(plan.detail);
            if (plan.pending.length > 0) {
                const pending = await createPendingShares(db, {
                    kind: params.kind,
                    resourceId: params.resourceId,
                    emails: plan.pending,
                    role: params.role,
                    invitedBy: params.createdBy,
                    invitedByEmail: params.createdByEmail,
                });
                if (!pending.ok) throw new Error(pending.detail);
                return { ok: true, grant: { email, role: params.role, pending: true } };
            }
        }
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
        actorId: string;
        actorEmail?: string | null;
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
    // Removing someone also withdraws a share still waiting for them.
    const pending = await cancelPendingShare(db, {
        kind: params.kind,
        resourceId: params.resourceId,
        email,
        actorId: params.actorId,
        actorEmail: params.actorEmail,
    });
    if (!pending.ok) return pending;
    return {
        ok: true,
        removed: ((data ?? []) as unknown[]).length > 0 || pending.removed,
    };
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
