// MFA-on-login toggle.
//
// Service layer behind user.routes.ts — see user.shared.ts for the module's
// contract. The requireMfaIfEnrolled guard stays in the route (HTTP layer);
// only the verified-TOTP factor lookup lives here. Reuses the profile-row
// helpers (ensureProfileRow / loadProfile) from user.profile.ts.

import { getUserApiKeyStatus } from "./user.apiKeyStore";
import { type Db } from "./user.shared";
import { ensureProfileRow, loadProfile } from "./user.profile";

async function userHasVerifiedTotpFactor(db: Db, userId: string) {
    const { data, error } = await db.auth.admin.getUserById(userId);
    if (error) return { ok: false as const, error };

    const factors = data.user?.factors ?? [];
    return {
        ok: true as const,
        hasVerifiedTotp: factors.some(
            (factor) =>
                factor.factor_type === "totp" && factor.status === "verified",
        ),
    };
}

export type SetMfaOnLoginResult =
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; kind: "no_factor"; detail: string }
    | { ok: false; kind: "db_error"; error: unknown };

export async function setMfaOnLogin(
    db: Db,
    userId: string,
    enabled: boolean,
): Promise<SetMfaOnLoginResult> {
    if (enabled) {
        const factorCheck = await userHasVerifiedTotpFactor(db, userId);
        if (!factorCheck.ok) {
            return {
                ok: false,
                kind: "db_error",
                error: factorCheck.error,
            };
        }
        if (!factorCheck.hasVerifiedTotp) {
            return {
                ok: false,
                kind: "no_factor",
                detail: "Set up an authenticator app before requiring verification on login.",
            };
        }
    }

    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError)
        return { ok: false, kind: "db_error", error: ensureError };

    const { error: updateError } = await db
        .from("user_profiles")
        .update({
            mfa_on_login: enabled,
            updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
    if (updateError)
        return { ok: false, kind: "db_error", error: updateError };

    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    const { data, error } = await loadProfile(db, userId, { apiKeyStatus });
    if (error) return { ok: false, kind: "db_error", error };
    return { ok: true, body: { ...data, apiKeyStatus } };
}
