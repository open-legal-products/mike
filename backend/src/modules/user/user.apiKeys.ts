// User BYO API keys: status read + save.
//
// Service layer behind user.routes.ts — see user.shared.ts for the module's
// contract. Security boundary preserved verbatim: writes funnel through
// saveUserApiKey (the crypto is never reimplemented here).

import { parseVertexServiceAccount } from "../../lib/llm/cloudProviders";
import {
    type ApiKeyProvider,
    type ApiKeyStatus,
    type SettingsApiKeyProvider,
    getUserApiKeyStatus,
    isSettingsApiKeyProvider,
    normalizeProviderSettings,
    saveUserApiKey,
    updateUserApiKeySettings,
} from "./user.apiKeyStore";
import { type Db, errorMessage } from "./user.shared";

export function getApiKeyStatus(db: Db, userId: string) {
    return getUserApiKeyStatus(userId, db);
}

export type SaveApiKeyResult =
    | { ok: true; status: ApiKeyStatus }
    | { ok: false; kind: "invalid_settings"; detail: string }
    | { ok: false; kind: "invalid_key"; detail: string }
    | { ok: false; kind: "no_saved_key"; detail: string }
    | { ok: false; kind: "save_failed"; error: unknown };

const SETTINGS_REQUIREMENT: Record<SettingsApiKeyProvider, string> = {
    bedrock: "A valid AWS region (for example us-east-1) is required with an Amazon Bedrock key.",
    azure: "A valid Azure OpenAI endpoint is required with an Azure OpenAI key: a resource name, or an https URL on openai.azure.com, cognitiveservices.azure.com or services.ai.azure.com.",
    "azure-foundry":
        "A valid Azure AI Foundry endpoint is required with an Azure AI Foundry key: a resource name, or an https URL on services.ai.azure.com, cognitiveservices.azure.com or openai.azure.com.",
    vertex: "A valid Vertex AI location (for example us-central1 or global) is required with a service-account key.",
    custom: "A public https base URL (for example https://llm.example.com/v1) is required with an OpenAI-compatible endpoint key.",
};

const INVALID_VERTEX_KEY =
    "Paste the full contents of a Google Cloud service-account key file (JSON with type \"service_account\", project_id, client_email and private_key).";

/**
 * Save, replace or remove a key. Keys that are only usable with a setting
 * (Bedrock, Azure OpenAI, Azure AI Foundry, Vertex AI, a custom endpoint)
 * also take `settings` (`{ region }` / `{ endpoint }` / `{ location }` /
 * `{ baseUrl }`):
 * - a key with valid settings saves both together;
 * - settings without a key change the settings of the already-saved key;
 * - neither removes the key and its settings.
 */
export async function saveApiKey(
    db: Db,
    params: {
        userId: string;
        provider: ApiKeyProvider;
        apiKey: string | null;
        settings?: unknown;
    },
): Promise<SaveApiKeyResult> {
    const { userId, provider, apiKey } = params;
    const key = apiKey?.trim() || null;
    // A Vertex "key" is a structured file; reject anything else up front
    // instead of storing a value that fails on first use.
    if (provider === "vertex" && key && !parseVertexServiceAccount(key)) {
        return { ok: false, kind: "invalid_key", detail: INVALID_VERTEX_KEY };
    }
    try {
        if (isSettingsApiKeyProvider(provider)) {
            const hasSettings =
                params.settings !== undefined && params.settings !== null;
            const settings = hasSettings
                ? normalizeProviderSettings(provider, params.settings)
                : null;
            if ((key || hasSettings) && !settings) {
                return {
                    ok: false,
                    kind: "invalid_settings",
                    detail: SETTINGS_REQUIREMENT[provider],
                };
            }
            if (!key && settings) {
                const updated = await updateUserApiKeySettings(
                    userId,
                    provider,
                    settings,
                    db,
                );
                if (!updated) {
                    return {
                        ok: false,
                        kind: "no_saved_key",
                        detail: "Save an API key before changing its settings.",
                    };
                }
            } else {
                await saveUserApiKey(userId, provider, key, db, settings ?? {});
            }
        } else {
            await saveUserApiKey(userId, provider, key, db);
        }
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
