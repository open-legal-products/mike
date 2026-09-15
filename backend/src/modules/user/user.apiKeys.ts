// User BYO API keys: status read + save.
//
// Service layer behind user.routes.ts — see user.shared.ts for the module's
// contract. Security boundary preserved verbatim: writes funnel through
// saveUserApiKey (the crypto is never reimplemented here).

import {
    type ApiKeyProvider,
    type ApiKeyStatus,
    getUserApiKeyStatus,
    hasEnvApiKey,
    saveUserApiKey,
} from "./user.apiKeyStore";
import { type Db, errorMessage } from "./user.shared";

export function getApiKeyStatus(db: Db, userId: string) {
    return getUserApiKeyStatus(userId, db);
}

export type SaveApiKeyResult =
    | { ok: true; status: ApiKeyStatus }
    | { ok: false; kind: "env_configured" }
    | { ok: false; kind: "save_failed"; error: unknown };

export async function saveApiKey(
    db: Db,
    params: { userId: string; provider: ApiKeyProvider; apiKey: string | null },
): Promise<SaveApiKeyResult> {
    const { userId, provider, apiKey } = params;
    try {
        if (hasEnvApiKey(provider)) {
            return { ok: false, kind: "env_configured" };
        }
        await saveUserApiKey(userId, provider, apiKey, db);
        const status = await getUserApiKeyStatus(userId, db);
        return { ok: true, status };
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/api-keys] save failed", {
            provider,
            error: detail,
        });
        return { ok: false, kind: "save_failed", error: err };
    }
}
