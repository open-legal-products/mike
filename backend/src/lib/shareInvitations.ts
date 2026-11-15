// Pending direct shares (public.share_invitations).
//
// Writing a direct grant used to require that the address already belonged
// to an account, and refused it otherwise ("… does not belong to a Mike
// user"). Any signed-in user could therefore learn who uses Mike by trying
// to share with them, and a hit put the person's name in the access list.
//
// Now a share with someone the sharer does not already work with (no shared
// organization) is recorded here instead, whether or not the address has an
// account, and the answer and the access-list entry are the same either way:
// "Pending", with the email only. The grant itself is written when an
// account that has CONFIRMED the address claims it (claimPendingShares,
// called from requireAuth), and only if the share still stands then: see
// claim_share_invitations in the 20261115_02 migration for the re-checks.
//
// This is the organization-invitation model (lib/orgs.ts) applied to direct
// shares: addressed by normalized email, one live row per (target, email),
// the same 14-day lifetime, created/accepted/cancelled/expired in the audit
// log. It is a separate table because an organization invitation is a
// request to join that the recipient answers, keyed by a non-null org_id
// with organization roles, while these name one resource and attach on
// sign-in without a reply, exactly as a direct grant always has.

import type { Db } from "./supabase";
import { recordAudit } from "./audit";
import { normalizeEmail as normalize } from "./userLookup";
import { invitationExpiry } from "./invitationExpiry";
import { safeError } from "./safeError";
import type { ProjectRole } from "./permissions";

export type ShareKind =
    | "project"
    | "chat"
    | "tabular_review"
    | "workflow"
    | "playbook";

/** Where each kind's live grants live, and its column in share_invitations. */
const TARGETS: Record<
    ShareKind,
    { column: string; grantTable: string; grantEmail: string }
> = {
    project: { column: "project_id", grantTable: "project_access_grants", grantEmail: "email" },
    chat: { column: "chat_id", grantTable: "chat_access_grants", grantEmail: "email" },
    tabular_review: {
        column: "tabular_review_id",
        grantTable: "tabular_review_access_grants",
        grantEmail: "email",
    },
    workflow: { column: "workflow_id", grantTable: "workflow_shares", grantEmail: "shared_with_email" },
    playbook: { column: "playbook_id", grantTable: "playbook_shares", grantEmail: "shared_with_email" },
};

export type PendingShare = {
    id: string;
    email: string;
    role: ProjectRole;
    invited_by: string | null;
    created_at: string;
    expires_at: string;
};

type Failure = { ok: false; detail: string };

/** What a share answers while it waits to be claimed: no name, no account. */
export type PendingGrantView = { email: string; role: ProjectRole; pending: true };

function message(error: unknown, fallback: string): string {
    return error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : fallback;
}

/** The audit columns that name the shared resource, where there is one. */
function auditTarget(kind: ShareKind, resourceId: string) {
    if (kind === "project") return { projectId: resourceId };
    if (kind === "chat") return { chatId: resourceId };
    if (kind === "tabular_review") return { reviewId: resourceId };
    return {};
}

/**
 * Whether two people belong to a common organization. The people a caller
 * already works with are the only ones whose accounts a share may reveal.
 */
export async function sharesAnOrganization(
    db: Db,
    userId: string,
    otherUserIds: string[],
): Promise<Set<string>> {
    // No early return for an empty list: the queries a share makes should
    // not depend on whether the address has an account.
    const shared = new Set<string>();
    const { data: mine, error } = await db
        .from("org_members")
        .select("org_id")
        .eq("user_id", userId);
    if (error) throw error;
    const orgIds = ((mine ?? []) as { org_id: string }[]).map((row) => row.org_id);
    if (orgIds.length === 0) return shared;
    const { data: theirs, error: theirsError } = await db
        .from("org_members")
        .select("user_id")
        .in("user_id", otherUserIds)
        .in("org_id", orgIds);
    if (theirsError) throw theirsError;
    for (const row of (theirs ?? []) as { user_id: string }[]) shared.add(row.user_id);
    return shared;
}

/**
 * Split the addresses of one share request into those whose grant is written
 * now and those that wait as pending shares.
 *
 * Now: an organization colleague of the sharer (as before this change), or
 * someone who already holds a grant on this resource (a role change; the
 * access list already shows them). Everyone else waits, whether or not the
 * address has an account, so the answer never depends on that.
 */
export async function planDirectShare(
    db: Db,
    params: { kind: ShareKind; resourceId: string; sharerId: string; emails: string[] },
): Promise<{ ok: true; immediate: string[]; pending: string[] } | Failure> {
    const emails = [
        ...new Set(params.emails.map((email) => normalizeEmail(email)).filter(Boolean)),
    ] as string[];
    if (emails.length === 0) return { ok: true, immediate: [], pending: [] };
    const target = TARGETS[params.kind];
    try {
        const [{ data: granted, error: grantedError }, { data: profiles, error: profilesError }] =
            await Promise.all([
                db
                    .from(target.grantTable)
                    .select(target.grantEmail)
                    .eq(target.column, params.resourceId)
                    .in(target.grantEmail, emails),
                db.from("user_profiles").select("user_id, email").in("email", emails),
            ]);
        if (grantedError) throw grantedError;
        if (profilesError) throw profilesError;
        const now = new Set(
            ((granted ?? []) as unknown as Record<string, string>[]).map((row) =>
                normalizeEmail(row[target.grantEmail]),
            ),
        );
        const accounts = (profiles ?? []) as { user_id: string; email: string }[];
        const colleagues = await sharesAnOrganization(
            db,
            params.sharerId,
            accounts.map((profile) => profile.user_id),
        );
        for (const profile of accounts)
            if (colleagues.has(profile.user_id)) now.add(normalizeEmail(profile.email));
        return {
            ok: true,
            immediate: emails.filter((email) => now.has(email)),
            pending: emails.filter((email) => !now.has(email)),
        };
    } catch (error) {
        return { ok: false, detail: message(error, "Failed to resolve share recipients") };
    }
}

/** The normalized address, or null for none. */
function normalizeEmail(value: unknown): string | null {
    return normalize(value) || null;
}

/**
 * Record (or refresh) one pending share per address. Sharing again with a
 * pending address changes its role and restarts its 14 days, as re-sharing
 * a grant changes its role.
 */
export async function createPendingShares(
    db: Db,
    params: {
        kind: ShareKind;
        resourceId: string;
        emails: string[];
        role: ProjectRole;
        invitedBy: string;
        invitedByEmail?: string | null;
    },
): Promise<{ ok: true; shares: PendingShare[] } | Failure> {
    const { column } = TARGETS[params.kind];
    const shares: PendingShare[] = [];
    for (const raw of params.emails) {
        const email = normalizeEmail(raw);
        if (!email) continue;
        const fields = { role: params.role, invited_by: params.invitedBy, expires_at: invitationExpiry() };
        const { data: live, error: liveError } = await db
            .from("share_invitations")
            .select("id")
            .eq(column, params.resourceId)
            .eq("email", email)
            .eq("status", "pending")
            .maybeSingle();
        if (liveError) return { ok: false, detail: liveError.message };
        const write = live
            ? db
                  .from("share_invitations")
                  .update(fields)
                  .eq("id", (live as { id: string }).id)
            : db
                  .from("share_invitations")
                  .insert({ [column]: params.resourceId, email, status: "pending", ...fields });
        const { data, error } = await write
            .select("id, email, role, invited_by, created_at, expires_at")
            .single();
        if (error || !data)
            return { ok: false, detail: error?.message ?? "Failed to save pending share" };
        const share = data as PendingShare;
        shares.push(share);
        await recordAudit(db, {
            userId: params.invitedBy,
            userEmail: params.invitedByEmail ?? null,
            action: "share.invite.created",
            title: email,
            ...auditTarget(params.kind, params.resourceId),
            detail: {
                resource_kind: params.kind,
                resource_id: params.resourceId,
                role: params.role,
                invitation_id: share.id,
            },
        });
    }
    return { ok: true, shares };
}

/** The live pending shares on one resource, oldest first. */
export async function listPendingShares(
    db: Db,
    kind: ShareKind,
    resourceId: string,
): Promise<{ ok: true; shares: PendingShare[] } | Failure> {
    const { data, error } = await db
        .from("share_invitations")
        .select("id, email, role, invited_by, created_at, expires_at")
        .eq(TARGETS[kind].column, resourceId)
        .eq("status", "pending")
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: true });
    if (error) return { ok: false, detail: error.message };
    return { ok: true, shares: (data ?? []) as PendingShare[] };
}

/**
 * The access-list entry for a pending share: the address and role only.
 * No name, photo or user id, so it reads the same whether or not the
 * address has an account.
 */
export function pendingPeopleRows(shares: PendingShare[]) {
    return shares.map((share) => ({
        user_id: null,
        email: share.email,
        display_name: null,
        profile_photo: null,
        role: share.role,
        pending: true as const,
    }));
}

/** A pending share in an owner's grant list (GET …/access), beside the grants. */
export function pendingGrantRows(shares: PendingShare[]) {
    return shares.map((share) => ({
        email: share.email,
        role: share.role,
        created_by: share.invited_by,
        created_at: share.created_at,
        expires_at: share.expires_at,
        pending: true as const,
    }));
}

/** Withdraw a pending share before it is claimed, by address or by its id. */
export async function cancelPendingShare(
    db: Db,
    params: {
        kind: ShareKind;
        resourceId: string;
        email?: string;
        id?: string;
        actorId: string;
        actorEmail?: string | null;
    },
): Promise<{ ok: true; removed: boolean } | Failure> {
    let query = db
        .from("share_invitations")
        .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
        .eq(TARGETS[params.kind].column, params.resourceId)
        .eq("status", "pending");
    if (params.id) {
        // A share id from another table is not a uuid of ours to look up.
        if (!/^[0-9a-f-]{36}$/i.test(params.id)) return { ok: true, removed: false };
        query = query.eq("id", params.id);
    } else {
        const email = normalizeEmail(params.email);
        if (!email) return { ok: true, removed: false };
        query = query.eq("email", email);
    }
    const { data, error } = await query.select("id, email");
    if (error) return { ok: false, detail: error.message };
    const rows = (data ?? []) as { id: string; email: string }[];
    for (const row of rows)
        await recordAudit(db, {
            userId: params.actorId,
            userEmail: params.actorEmail ?? null,
            action: "share.invite.cancelled",
            title: row.email,
            ...auditTarget(params.kind, params.resourceId),
            detail: {
                resource_kind: params.kind,
                resource_id: params.resourceId,
                invitation_id: row.id,
            },
        });
    return { ok: true, removed: rows.length > 0 };
}

type ClaimRow = {
    invitation_id: string;
    resource_kind: ShareKind;
    resource_id: string;
    email: string;
    role: ProjectRole;
    invited_by: string | null;
    outcome: "accepted" | "refused";
};

/**
 * Turn the signed-in person's pending shares into grants. `userEmail` is
 * requireAuth's authorization email, which is empty until the address is
 * confirmed; the database function checks the confirmation again itself.
 */
export async function claimPendingShares(
    db: Db,
    params: { userId: string; userEmail: string },
): Promise<void> {
    if (!normalizeEmail(params.userEmail)) return;
    const { data, error } = await db.rpc("claim_share_invitations", {
        p_user_id: params.userId,
    });
    if (error) throw error;
    for (const row of (data ?? []) as ClaimRow[]) {
        await recordAudit(db, {
            userId: params.userId,
            userEmail: params.userEmail,
            action: row.outcome === "accepted" ? "share.invite.accepted" : "share.invite.refused",
            title: row.email,
            ...auditTarget(row.resource_kind, row.resource_id),
            detail: {
                resource_kind: row.resource_kind,
                resource_id: row.resource_id,
                role: row.role,
                invited_by: row.invited_by,
                invitation_id: row.invitation_id,
            },
        });
    }
}

const recentClaims = new Map<string, number>();
const CLAIM_INTERVAL_MS = 30_000;

/**
 * claimPendingShares for requireAuth: at most once per user every 30 seconds
 * in this process, and never failing the request it rides on. A share made
 * while its recipient is signed in attaches within that interval.
 */
export async function claimPendingSharesQuietly(
    db: Db,
    params: { userId: string; userEmail: string },
): Promise<void> {
    if (!normalizeEmail(params.userEmail)) return;
    const now = Date.now();
    if ((recentClaims.get(params.userId) ?? 0) > now) return;
    if (recentClaims.size > 10_000) recentClaims.clear();
    recentClaims.set(params.userId, now + CLAIM_INTERVAL_MS);
    try {
        await claimPendingShares(db, params);
    } catch (error) {
        // Try again on the next request rather than in 30 seconds.
        recentClaims.delete(params.userId);
        console.warn("[share-invitations] claim failed", safeError(error));
    }
}

export function resetPendingShareClaimsForTests(): void {
    recentClaims.clear();
}

/**
 * Maintenance sweep: mark pending shares past their expiry as expired and
 * audit each one against the person who made it. Claiming already ignores
 * them; this records that they lapsed and keeps the pending index small.
 */
export async function expirePendingShares(db: Db): Promise<number> {
    const { data, error } = await db
        .from("share_invitations")
        .update({ status: "expired" })
        .eq("status", "pending")
        .lte("expires_at", new Date().toISOString())
        .select(
            "id, email, invited_by, project_id, chat_id, tabular_review_id, workflow_id, playbook_id",
        );
    if (error) throw error;
    const rows = (data ?? []) as (Record<string, string | null> & { id: string; email: string })[];
    for (const row of rows) {
        if (!row.invited_by) continue;
        const kind = (Object.keys(TARGETS) as ShareKind[]).find(
            (candidate) => row[TARGETS[candidate].column],
        );
        if (!kind) continue;
        const resourceId = row[TARGETS[kind].column] as string;
        await recordAudit(db, {
            userId: row.invited_by,
            action: "share.invite.expired",
            title: row.email,
            ...auditTarget(kind, resourceId),
            detail: { resource_kind: kind, resource_id: resourceId, invitation_id: row.id },
        });
    }
    return rows.length;
}

/** Account deletion: nothing may still be waiting for this address. */
export async function removePendingSharesForEmail(
    db: Db,
    email: string | null | undefined,
): Promise<void> {
    const normalized = normalizeEmail(email);
    if (!normalized) return;
    const { error } = await db
        .from("share_invitations")
        .delete()
        .eq("email", normalized);
    if (error)
        throw new Error(
            `Failed to remove pending shares: ${error.message ?? "unknown error"}`,
        );
}
