// User BYO API keys: status read + save.
//
// Service layer behind user.routes.ts — see user.shared.ts for the module's
// contract. Security boundary preserved verbatim: writes funnel through
// saveUserApiKey (the crypto is never reimplemented here).

import {
    credentialEndpointHost,
    isEndpointScopedProvider,
    parseVertexServiceAccount,
} from "../../lib/llm/cloudProviders";
import type { ProviderSettings } from "../../lib/llm";
import {
    type ApiKeyOwner,
    type ApiKeyProvider,
    type ApiKeyStatus,
    type SettingsApiKeyProvider,
    getApiKeyStatusFor,
    getSavedApiKeySettings,
    getUserApiKeyStatus,
    isSettingsApiKeyProvider,
    normalizeProviderSettings,
    saveApiKeyFor,
    updateApiKeySettings,
    userKeyOwner,
} from "./user.apiKeyStore";
import { AppError } from "../../lib/appError";
import { type Db } from "./user.shared";

export function getApiKeyStatus(db: Db, userId: string) {
    return getUserApiKeyStatus(userId, db);
}

export type SaveApiKeyResult =
    | { ok: true; status: ApiKeyStatus }
    | { ok: false; kind: "invalid_settings"; detail: string }
    | { ok: false; kind: "invalid_key"; detail: string }
    | { ok: false; kind: "no_saved_key"; detail: string }
    | { ok: false; kind: "key_required"; detail: string }
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

export const REENTER_KEY_FOR_ENDPOINT =
    "Re-enter the API key to change this provider's endpoint.";

/**
 * True when changing a saved key's settings to `next` would send the stored
 * secret to a different host (or the saved host is unknown because the
 * saved setting no longer validates). Such a change must come with the key.
 */
async function endpointChangeNeedsKey(
    db: Db,
    owner: ApiKeyOwner,
    provider: SettingsApiKeyProvider,
    next: ProviderSettings,
): Promise<boolean> {
    if (!isEndpointScopedProvider(provider)) return false;
    const saved = await getSavedApiKeySettings(owner, provider, db);
    // No saved key: updateApiKeySettings reports that on its own.
    if (!saved) return false;
    const current = normalizeProviderSettings(provider, saved.settings);
    if (!current) return true;
    const before = credentialEndpointHost(provider, current);
    return !before || before !== credentialEndpointHost(provider, next);
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

/**
 * The same save, for a person's key or an organization's. One
 * implementation, so an organization's key gets every check a personal one
 * does (a Vertex key's shape, a setting that validates, the re-entry an
 * endpoint move requires) rather than a second copy of them to keep in step.
 * The caller authorises the write; `savedBy` is recorded on an
 * organization's key.
 */
export async function saveApiKeyForOwner(
    db: Db,
    params: {
        owner: ApiKeyOwner;
        provider: ApiKeyProvider;
        apiKey: string | null;
        settings?: unknown;
        savedBy?: string;
    },
): Promise<SaveApiKeyResult> {
    const { owner, provider, apiKey, savedBy } = params;
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
            if (
                !key &&
                settings &&
                (await endpointChangeNeedsKey(db, owner, provider, settings))
            ) {
                return {
                    ok: false,
                    kind: "key_required",
                    detail: REENTER_KEY_FOR_ENDPOINT,
                };
            }
            if (!key && settings) {
                const updated = await updateApiKeySettings(
                    owner,
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
                await saveApiKeyFor(
                    owner,
                    provider,
                    key,
                    db,
                    settings ?? {},
                    savedBy,
                );
            }
        } else {
            await saveApiKeyFor(owner, provider, key, db, {}, savedBy);
        }
        const status = await getApiKeyStatusFor(owner, db);
        return { ok: true, status };
    } catch (err) {
        // One event, from the route's sendInternalError: the kind names the
        // flow, the thrown value stays the cause so its code still extracts.
        return {
            ok: false,
            kind: "save_failed",
            error: new AppError("user.api_key_failed", "API key save failed", {
                cause: err,
            }),
        };
    }
}
