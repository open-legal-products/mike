// user profile operations — implementation behind the module facade.
import { getUserApiKeyStatus } from "./user.apiKeyStore";
import { findProfileUserByEmail } from "../../lib/userLookup";
import { replaceUserRouterModels, ROUTER_SLUGS, type RouterSlug } from "../../lib/routerModels";
import { type Db } from "./user.shared";
import { ensureProfileRow, loadProfile } from "./user.profile.load";

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

export async function lookupUserByEmail(
    db: Db,
    email: string,
): Promise<{
    exists: boolean;
    email: string;
    display_name: string | null;
}> {
    const user = await findProfileUserByEmail(db, email);
    return {
        exists: !!user,
        email: user?.email ?? email.trim().toLowerCase(),
        display_name: user?.display_name ?? null,
    };
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

// Records the personalisation answers and marks onboarding complete. Unlike
// the sendInternalError-backed profile handlers, these two surfaces still
// report the underlying message, so the failure results carry `detail`.
export async function completeUserOnboarding(
    db: Db,
    userId: string,
    update: PersonalisationUpdate,
): Promise<
    { ok: true; body: Record<string, unknown> } | { ok: false; detail: string }
> {
    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError) return { ok: false, detail: ensureError.message };

    const { error: updateError } = await db
        .from("user_profiles")
        .update({
            ...update,
            onboarding_version: 1,
            updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
    if (updateError) return { ok: false, detail: updateError.message };

    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    const { data, error } = await loadProfile(db, userId, { apiKeyStatus });
    if (error) return { ok: false, detail: error.message };
    return { ok: true, body: { ...data, apiKeyStatus } };
}

export type RecordPasswordSetResult =
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; kind: "db_error"; detail: string }
    | { ok: false; kind: "not_recorded"; detail: string };

// Record password capability only after verifying Supabase's auth.users row.
export async function recordPasswordSet(
    db: Db,
    userId: string,
): Promise<RecordPasswordSetResult> {
    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError)
        return { ok: false, kind: "db_error", detail: ensureError.message };

    const { data: passwordSetAt, error: syncError } = await db.rpc(
        "sync_user_password_set",
        { p_user_id: userId },
    );
    if (syncError)
        return { ok: false, kind: "db_error", detail: syncError.message };
    if (!passwordSetAt) {
        return {
            ok: false,
            kind: "not_recorded",
            detail: "Supabase has not recorded a password for this account",
        };
    }

    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    const { data, error } = await loadProfile(db, userId, { apiKeyStatus });
    if (error) return { ok: false, kind: "db_error", detail: error.message };
    return { ok: true, body: { ...data, apiKeyStatus } };
}
