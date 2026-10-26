// Personal settings adapters over the shared owner-aware credential capability.
import type { Db } from "../../lib/supabase";
import type { ServiceResult } from "../../lib/serviceResult";
import {
    getUserApiKeyStatus,
    userKeyOwner,
    saveApiKeyForOwner,
    setApiKeyEnabledFor,
    type ApiKeyProvider,
    type ApiKeyStatus,
    type SaveApiKeyResult,
} from "../../lib/providerCredentials/index";
export function getApiKeyStatus(db: Db, userId: string) {
    return getUserApiKeyStatus(userId, db);
}

/**
 * Save, replace or remove a key. Keys that are only usable with a setting
 * (Bedrock, Azure OpenAI, Azure AI Foundry, Vertex AI, a custom endpoint)
 * also take `settings` (`{ region }` / `{ endpoint }` / `{ location }` /
 * `{ baseUrl }`):
 * - a key with valid settings saves both together;
 * - settings without a key change the settings of the already-saved key,
 *   except that moving a key to a different endpoint host (custom endpoint,
 *   Azure OpenAI, Azure AI Foundry) requires the key to be re-entered;
 * - neither removes the key and its settings.
 */
export function saveApiKey(
    db: Db,
    params: {
        userId: string;
        provider: ApiKeyProvider;
        apiKey: string | null;
        settings?: unknown;
    },
): Promise<SaveApiKeyResult> {
    return saveApiKeyForOwner(db, {
        owner: userKeyOwner(params.userId),
        provider: params.provider,
        apiKey: params.apiKey,
        settings: params.settings,
    });
}

/** Toggle a saved credential without changing its encrypted value or models. */
export function setApiKeyEnabled(
    db: Db,
    userId: string,
    provider: ApiKeyProvider,
    enabled: boolean,
): Promise<ServiceResult<ApiKeyStatus>> {
    return setApiKeyEnabledFor(db, userKeyOwner(userId), provider, enabled);
}
