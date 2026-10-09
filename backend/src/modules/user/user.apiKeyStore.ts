import crypto from "crypto";
import { createServerSupabase } from "../../lib/supabase";
import type { Db } from "../../lib/supabase";
import { logError } from "../../lib/log";
import type { ProviderSettings, UserApiKeys } from "../../lib/llm";
import {
    envAzureCredentials,
    envAzureFoundryCredentials,
    envBedrockCredentials,
    envVertexCredentials,
    envVertexServiceAccountKey,
    normalizeAwsRegion,
    normalizeAzureEndpoint,
    normalizeAzureFoundryEndpoint,
    normalizeCustomBaseUrl,
    normalizeVertexLocation,
} from "../../lib/llm/cloudProviders";

export type ApiKeyProvider =
    | "claude"
    | "gemini"
    | "openai"
    | "mistral"
    | "openrouter"
    | "vercel"
    | "opencode-go"
    | "bedrock"
    | "azure"
    | "azure-foundry"
    | "vertex"
    | "xai"
    | "custom"
    | "courtlistener";
export type ApiKeySource = "user" | "env" | null;
/** Providers whose key is only usable together with a non-secret setting. */
export type SettingsApiKeyProvider = keyof ProviderSettings;
export type ApiKeyStatus = Record<ApiKeyProvider, boolean> & {
    sources: Record<ApiKeyProvider, ApiKeySource>;
    enabled: Partial<Record<ApiKeyProvider, boolean>>;
    /**
     * The settings saved with the user's own key. Deployment (env) settings
     * are not echoed back: an operator's Azure resource is not the user's
     * business.
     */
    settings: ProviderSettings;
};

type EncryptedKeyRow = {
    provider: ApiKeyProvider;
    encrypted_key: string;
    iv: string;
    auth_tag: string;
    settings?: unknown;
    enabled?: boolean;
};

const PROVIDERS: ApiKeyProvider[] = [
    "claude",
    "gemini",
    "openai",
    "mistral",
    "openrouter",
    "vercel",
    "opencode-go",
    "bedrock",
    "azure",
    "azure-foundry",
    "vertex",
    "xai",
    "custom",
    "courtlistener",
];

const SETTINGS_PROVIDERS: readonly SettingsApiKeyProvider[] = [
    "bedrock",
    "azure",
    "azure-foundry",
    "vertex",
    "custom",
];

export function isSettingsApiKeyProvider(
    provider: ApiKeyProvider,
): provider is SettingsApiKeyProvider {
    return (SETTINGS_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * Validate the setting a key must be saved with ({ region }, { endpoint },
 * { location } or { baseUrl }) and return it as a one-entry
 * ProviderSettings, or null when the value is missing or malformed.
 */
export function normalizeProviderSettings(
    provider: SettingsApiKeyProvider,
    value: unknown,
): ProviderSettings | null {
    const record =
        value && typeof value === "object"
            ? (value as Record<string, unknown>)
            : {};
    if (provider === "bedrock") {
        const region = normalizeAwsRegion(record.region);
        return region ? { bedrock: { region } } : null;
    }
    if (provider === "azure") {
        const endpoint = normalizeAzureEndpoint(record.endpoint);
        return endpoint ? { azure: { endpoint } } : null;
    }
    if (provider === "azure-foundry") {
        const endpoint = normalizeAzureFoundryEndpoint(record.endpoint);
        return endpoint ? { "azure-foundry": { endpoint } } : null;
    }
    if (provider === "vertex") {
        const location = normalizeVertexLocation(record.location);
        return location ? { vertex: { location } } : null;
    }
    const baseUrl = normalizeCustomBaseUrl(record.baseUrl);
    return baseUrl ? { custom: { baseUrl } } : null;
}

function envApiKey(provider: ApiKeyProvider): string | null {
    switch (provider) {
        case "claude":
            return (
                process.env.ANTHROPIC_API_KEY?.trim() ||
                process.env.CLAUDE_API_KEY?.trim() ||
                null
            );
        case "gemini":
            return process.env.GEMINI_API_KEY?.trim() || null;
        case "mistral":
            return process.env.MISTRAL_API_KEY?.trim() || null;
        case "openai":
            return process.env.OPENAI_API_KEY?.trim() || null;
        case "openrouter":
            return process.env.OPENROUTER_API_KEY?.trim() || null;
        case "vercel":
            return (
                process.env.AI_GATEWAY_API_KEY?.trim() ||
                process.env.VERCEL_AI_GATEWAY_API_KEY?.trim() ||
                null
            );
        case "opencode-go":
            return process.env.OPENCODE_API_KEY?.trim() || null;
        // A cloud key without its region/endpoint cannot be used, so the
        // environment only counts as configured when both halves are set.
        case "bedrock":
            return envBedrockCredentials()?.apiKey ?? null;
        case "azure":
            return envAzureCredentials()?.apiKey ?? null;
        case "azure-foundry":
            return envAzureFoundryCredentials()?.apiKey ?? null;
        case "vertex":
            return envVertexCredentials() ? envVertexServiceAccountKey() : null;
        case "xai":
            return process.env.XAI_API_KEY?.trim() || null;
        // A custom endpoint is always the user's own; deployments declare
        // shared endpoints in MIKE_MODEL_CONFIG_JSON.
        case "custom":
            return null;
        case "courtlistener":
            return process.env.COURTLISTENER_API_TOKEN?.trim() || null;
        default:
            return null;
    }
}

export function hasEnvApiKey(provider: ApiKeyProvider): boolean {
    return !!envApiKey(provider);
}

const KEY_SALT = "mike-user-api-keys-v1";
// scryptSync is deliberately slow (~40ms); deriving it on every encrypt and
// decrypt made key reads dominate request latency. The secret and salt are
// fixed for the process lifetime, so cache the derived key per pair.
const derivedKeys = new Map<string, Buffer>();

function encryptionKey(): Buffer {
    const secret = process.env.USER_API_KEYS_ENCRYPTION_SECRET;
    if (!secret) {
        throw new Error("USER_API_KEYS_ENCRYPTION_SECRET is not configured");
    }
    const cacheKey = `${KEY_SALT}:${secret}`;
    const cached = derivedKeys.get(cacheKey);
    if (cached) return cached;
    const derived = crypto.scryptSync(secret, KEY_SALT, 32);
    derivedKeys.set(cacheKey, derived);
    return derived;
}

function encrypt(value: string): Omit<EncryptedKeyRow, "provider"> {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
    const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
    ]);
    return {
        encrypted_key: encrypted.toString("base64"),
        iv: iv.toString("base64"),
        auth_tag: cipher.getAuthTag().toString("base64"),
    };
}

function decrypt(row: EncryptedKeyRow): string | null {
    try {
        const decipher = crypto.createDecipheriv(
            "aes-256-gcm",
            encryptionKey(),
            Buffer.from(row.iv, "base64"),
        );
        decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
        const decrypted = Buffer.concat([
            decipher.update(Buffer.from(row.encrypted_key, "base64")),
            decipher.final(),
        ]);
        return decrypted.toString("utf8");
    } catch (err) {
        logError("user-api-keys", err, {
            detail: "failed to decrypt stored key",
            provider: row.provider,
        });
        return null;
    }
}

function isProvider(value: string): value is ApiKeyProvider {
    return (PROVIDERS as string[]).includes(value);
}

export function normalizeApiKeyProvider(value: string): ApiKeyProvider | null {
    return isProvider(value) ? value : null;
}

export async function getUserApiKeyStatus(
    userId: string,
    db: Db = createServerSupabase(),
): Promise<ApiKeyStatus> {
    const status: ApiKeyStatus = {
        claude: false,
        gemini: false,
        openai: false,
        mistral: false,
        openrouter: false,
        vercel: false,
        "opencode-go": false,
        bedrock: false,
        azure: false,
        "azure-foundry": false,
        vertex: false,
        xai: false,
        custom: false,
        courtlistener: false,
        sources: {
            claude: null,
            gemini: null,
            openai: null,
            mistral: null,
            openrouter: null,
            vercel: null,
            "opencode-go": null,
            bedrock: null,
            azure: null,
            "azure-foundry": null,
            vertex: null,
            xai: null,
            custom: null,
            courtlistener: null,
        },
        settings: {},
        enabled: {},
    };

    for (const provider of PROVIDERS) {
        if (hasEnvApiKey(provider)) {
            status[provider] = true;
            status.sources[provider] = "env";
        }
    }

    const { data, error } = await db
        .from("user_api_keys")
        .select("provider, settings, enabled")
        .eq("user_id", userId);
    if (error) throw error;

    for (const row of data ?? []) {
        const provider = normalizeApiKeyProvider(String(row.provider));
        if (!provider) continue;
        status.enabled[provider] = row.enabled !== false;
        if (row.enabled === false) {
            status[provider] = false;
            status.sources[provider] = "user";
        }
        if (isSettingsApiKeyProvider(provider)) {
            // A saved key without a valid setting cannot be used; report it
            // as not configured rather than as a key that will fail later.
            const settings = normalizeProviderSettings(provider, row.settings);
            if (!settings) continue;
            Object.assign(status.settings, settings);
        }
        status[provider] = row.enabled !== false;
        status.sources[provider] = "user";
    }

    return status;
}

export async function getUserApiKeys(
    userId: string,
    db: Db = createServerSupabase(),
): Promise<UserApiKeys> {
    const apiKeys: UserApiKeys = {
        claude: envApiKey("claude"),
        gemini: envApiKey("gemini"),
        openai: envApiKey("openai"),
        mistral: envApiKey("mistral"),
        openrouter: envApiKey("openrouter"),
        vercel: envApiKey("vercel"),
        "opencode-go": envApiKey("opencode-go"),
        bedrock: envApiKey("bedrock"),
        azure: envApiKey("azure"),
        "azure-foundry": envApiKey("azure-foundry"),
        vertex: envApiKey("vertex"),
        xai: envApiKey("xai"),
        custom: envApiKey("custom"),
        courtlistener: envApiKey("courtlistener"),
    };
    const envBedrock = envBedrockCredentials();
    const envAzure = envAzureCredentials();
    const envAzureFoundry = envAzureFoundryCredentials();
    const envVertex = envVertexCredentials();
    const providerSettings: ProviderSettings = {
        bedrock: envBedrock ? { region: envBedrock.region } : null,
        azure: envAzure ? { endpoint: envAzure.endpoint } : null,
        "azure-foundry": envAzureFoundry
            ? { endpoint: envAzureFoundry.endpoint }
            : null,
        vertex: envVertex ? { location: envVertex.location } : null,
        custom: null,
    };
    apiKeys.providerSettings = providerSettings;

    const { data, error } = await db
        .from("user_api_keys")
        .select("provider, encrypted_key, iv, auth_tag, settings, enabled")
        .eq("user_id", userId);
    if (error) throw error;

    for (const row of (data ?? []) as EncryptedKeyRow[]) {
        const provider = normalizeApiKeyProvider(row.provider);
        if (!provider) continue;
        if (row.enabled === false) {
            apiKeys[provider] = null;
            apiKeys.disabledProviders = [...(apiKeys.disabledProviders ?? []), provider];
            if (isSettingsApiKeyProvider(provider)) providerSettings[provider] = null;
            continue;
        }
        const userKey = decrypt(row)?.trim() || null;
        if (!userKey) continue;
        if (isSettingsApiKeyProvider(provider)) {
            // The user's key replaces the environment's key AND setting, so
            // it never runs against the operator's region or resource.
            const settings = normalizeProviderSettings(provider, row.settings);
            if (!settings) continue;
            Object.assign(providerSettings, settings);
        }
        apiKeys[provider] = userKey;
    }

    return apiKeys;
}

export async function saveUserApiKey(
    userId: string,
    provider: ApiKeyProvider,
    value: string | null,
    db: Db = createServerSupabase(),
    settings: ProviderSettings = {},
): Promise<void> {
    const normalized = value?.trim() || null;
    if (!normalized) {
        const { error } = await db
            .from("user_api_keys")
            .delete()
            .eq("user_id", userId)
            .eq("provider", provider);
        if (error) throw error;
        return;
    }

    const { error } = await db.from("user_api_keys").upsert(
        {
            user_id: userId,
            provider,
            ...encrypt(normalized),
            settings: isSettingsApiKeyProvider(provider)
                ? (settings[provider] ?? null)
                : null,
            updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,provider" },
    );
    if (error) throw error;
}

/**
 * Change the setting saved with an existing key (a region, endpoint,
 * location or base URL) without
 * re-entering the key. Returns false when the user has no saved key for the
 * provider.
 */
export async function updateUserApiKeySettings(
    userId: string,
    provider: SettingsApiKeyProvider,
    settings: ProviderSettings,
    db: Db = createServerSupabase(),
): Promise<boolean> {
    const value = settings[provider];
    if (!value) throw new Error(`Missing ${provider} settings`);
    const { data, error } = await db
        .from("user_api_keys")
        .update({ settings: value, updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("provider", provider)
        .select("provider");
    if (error) throw error;
    return (data ?? []).length > 0;
}
