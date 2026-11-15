// user profile operations — implementation behind the module facade.
import { getUserApiKeyStatus } from "../../lib/providerCredentials/index";
import { findProfileUserByEmail } from "../../lib/userLookup";
import { replaceUserRouterModels, ROUTER_SLUGS, type RouterSlug } from "../../lib/routerModels";
import { type Db } from "./user.shared";
import { ensureProfileRow, loadProfile } from "./user.profile.load";
import { AppError, type ErrorKind } from "../../lib/appError";

import { PersonalisationUpdate } from "./user.profile.validation";

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export async function bootstrapUserProfile(
    db: Db,
    userId: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    const error = await ensureProfileRow(db, userId);
    if (error) return { ok: false, error };
    return { ok: true };
}

export async function getUserProfile(
    db: Db,
    userId: string,
): Promise<
    { ok: true; body: Record<string, unknown> } | { ok: false; error: unknown }
> {
    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    const { data, error } = await loadProfile(db, userId, {
        repairMissing: true,
        apiKeyStatus,
    });
    if (error) return { ok: false, error };
    return { ok: true, body: { ...data, apiKeyStatus } };
}

/**
 * Returns the minimal identity needed to label a new direct share.
 *
 * Any signed-in user can call this with any address, so it resolves only
 * people the caller already knows: themselves and members of an organization
 * they belong to. Every other address, with or without an account, gets the
 * same unresolved answer, and the share endpoint decides whether it can
 * receive the share. Otherwise a free account could test a list of addresses
 * for accounts and collect the names behind them.
 */
export async function lookupUserByEmail(
    db: Db,
    callerId: string,
    email: string,
): Promise<{
    exists: boolean;
    email: string;
    display_name: string | null;
}> {
    const unresolved = {
        exists: false,
        email: email.trim().toLowerCase(),
        display_name: null,
    };
    const user = await findProfileUserByEmail(db, email);
    if (!user) return unresolved;
    if (user.id !== callerId && !(await sharesAnOrganization(db, callerId, user.id)))
        return unresolved;
    return { exists: true, email: user.email, display_name: user.display_name };
}

async function sharesAnOrganization(db: Db, userId: string, otherUserId: string) {
    const { data: mine, error } = await db
        .from("org_members")
        .select("org_id")
        .eq("user_id", userId);
    if (error) throw error;
    const orgIds = ((mine ?? []) as { org_id: string }[]).map((row) => row.org_id);
    if (orgIds.length === 0) return false;

    const { data: shared, error: sharedError } = await db
        .from("org_members")
        .select("org_id")
        .eq("user_id", otherUserId)
        .in("org_id", orgIds)
        .limit(1);
    if (sharedError) throw sharedError;
    return (shared ?? []).length > 0;
}

export async function updateUserProfile(
    db: Db,
    userId: string,
    update: Record<string, unknown>,
    routerModels?: Partial<Record<RouterSlug, string[]>>,
): Promise<
    { ok: true; body: Record<string, unknown> } | { ok: false; error: unknown }
> {
    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError) return { ok: false, error: ensureError };

    const { error: updateError } = await db
        .from("user_profiles")
        .update(update)
        .eq("user_id", userId);
    if (updateError) return { ok: false, error: updateError };

    for (const slug of ROUTER_SLUGS) {
        const models = routerModels?.[slug];
        if (models === undefined) continue;
        try {
            await replaceUserRouterModels(userId, slug, models, db);
        } catch (routerModelsError) {
            return { ok: false, error: routerModelsError };
        }
    }

    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    const { data, error } = await loadProfile(db, userId, { apiKeyStatus });
    if (error) return { ok: false, error };
    return { ok: true, body: { ...data, apiKeyStatus } };
}

// ---------------------------------------------------------------------------
// Onboarding + password capability
// ---------------------------------------------------------------------------

// A failed query as the route's sendInternalError should report it: the kind
// names what broke, the PostgREST object stays the cause so its code still
// extracts; `detail` keeps the message for callers that read it.
function profileWriteFailure(
    kind: ErrorKind,
    message: string,
    cause: { message: string },
): { ok: false; detail: string; error: AppError } {
    return {
        ok: false,
        detail: cause.message,
        error: new AppError(kind, message, { cause }),
    };
}

// Records the personalisation answers and marks onboarding complete.
export async function completeUserOnboarding(
    db: Db,
    userId: string,
    update: PersonalisationUpdate,
): Promise<
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; detail: string; error: AppError }
> {
    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError)
        return profileWriteFailure("db.query_failed", "profile row could not be ensured", ensureError);

    const { error: updateError } = await db
        .from("user_profiles")
        .update({
            ...update,
            onboarding_version: 1,
            updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
    if (updateError)
        return profileWriteFailure("db.query_failed", "onboarding update failed", updateError);

    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    const { data, error } = await loadProfile(db, userId, { apiKeyStatus });
    if (error) return profileWriteFailure("db.query_failed", "profile load failed", error);
    return { ok: true, body: { ...data, apiKeyStatus } };
}

export type RecordPasswordSetResult =
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; kind: "db_error"; detail: string; error: AppError }
    | { ok: false; kind: "not_recorded"; detail: string };

// Record password capability only after verifying Supabase's auth.users row.
export async function recordPasswordSet(
    db: Db,
    userId: string,
): Promise<RecordPasswordSetResult> {
    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError)
        return {
            kind: "db_error",
            ...profileWriteFailure("db.query_failed", "profile row could not be ensured", ensureError),
        };

    const { data: passwordSetAt, error: syncError } = await db.rpc(
        "sync_user_password_set",
        { p_user_id: userId },
    );
    if (syncError)
        return {
            kind: "db_error",
            ...profileWriteFailure("db.rpc_failed", "sync_user_password_set failed", syncError),
        };
    if (!passwordSetAt) {
        return {
            ok: false,
            kind: "not_recorded",
            detail: "Supabase has not recorded a password for this account",
        };
    }

    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    const { data, error } = await loadProfile(db, userId, { apiKeyStatus });
    if (error)
        return {
            kind: "db_error",
            ...profileWriteFailure("db.query_failed", "profile load failed", error),
        };
    return { ok: true, body: { ...data, apiKeyStatus } };
}
