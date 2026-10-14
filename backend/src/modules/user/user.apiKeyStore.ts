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
export type ApiKeySource = "user" | "org" | "env" | null;

/**
 * Whose key a row is. A person's keys and an organization's keys have the
 * same shape, encryption and rules, in two tables; everything below reads
 * and writes either through this, so there is one implementation of both.
 */
export type ApiKeyOwner =
    | { kind: "user"; id: string }
    | { kind: "org"; id: string };

const OWNER_TABLE = {
    user: { table: "user_api_keys", column: "user_id" },
    org: { table: "org_api_keys", column: "org_id" },
} as const;

export const userKeyOwner = (userId: string): ApiKeyOwner => ({
    kind: "user",
    id: userId,
});
export const orgKeyOwner = (orgId: string): ApiKeyOwner => ({
    kind: "org",
    id: orgId,
});
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

export function getUserApiKeyStatus(
    userId: string,
    db: Db = createServerSupabase(),
): Promise<ApiKeyStatus> {
    return getApiKeyStatusFor(userKeyOwner(userId), db);
}

/**
 * Which providers `owner` has a usable key for, without any secret. For an
 * organization this is what its admins see in settings; the deployment's
 * environment keys are reported for both, since they sit under either.
 */
export async function getApiKeyStatusFor(
    owner: ApiKeyOwner,
    db: Db = createServerSupabase(),
): Promise<ApiKeyStatus> {
    const status = envApiKeyStatus();
    overlayStatusRows(status, await loadStatusRows(owner, db), owner.kind);
    return status;
}

/**
 * What a member can run inside an organization, without any secret: the
 * status counterpart of getEffectiveApiKeys, built from the same layers in
 * the same order, so the model picker and the request agree. `sources` says
 * whose key a provider would run on.
 */
export async function getEffectiveApiKeyStatus(
    userId: string,
    orgId: string,
    db: Db = createServerSupabase(),
): Promise<ApiKeyStatus> {
    const scope = await loadOrgKeyScope(userId, orgId, db);
    if (!scope) return getUserApiKeyStatus(userId, db);
    const status = envApiKeyStatus();
    if (scope.allowPersonal)
        overlayStatusRows(
            status,
            await loadStatusRows(userKeyOwner(userId), db),
            "user",
        );
    overlayStatusRows(
        status,
        await loadStatusRows(orgKeyOwner(orgId), db),
        "org",
    );
    return status;
}

type StatusRow = { provider: unknown; settings: unknown; enabled: unknown };

async function loadStatusRows(owner: ApiKeyOwner, db: Db): Promise<StatusRow[]> {
    const { table, column } = OWNER_TABLE[owner.kind];
    const { data, error } = await db
        .from(table)
        .select("provider, settings, enabled")
        .eq(column, owner.id);
    if (error) {
        if (owner.kind === "org" && isMissingOrgKeySchema(error)) return [];
        throw error;
    }
    return (data ?? []) as StatusRow[];
}

/** The deployment's own keys, as a status: what sits under every owner. */
function envApiKeyStatus(): ApiKeyStatus {
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
    return status;
}

/** Lay one owner's saved rows over `status`, in place (see overlayKeyRows). */
function overlayStatusRows(
    status: ApiKeyStatus,
    rows: StatusRow[],
    kind: ApiKeyOwner["kind"],
): void {
    for (const row of rows) {
        const provider = normalizeApiKeyProvider(String(row.provider));
        if (!provider) continue;
        status.enabled[provider] = row.enabled !== false;
        // This owner's row is the newer answer: an earlier layer's setting
        // for the provider does not describe the key that will run.
        if (isSettingsApiKeyProvider(provider))
            delete (status.settings as Record<string, unknown>)[provider];
        if (row.enabled === false) {
            status[provider] = false;
            status.sources[provider] = kind;
        }
        if (isSettingsApiKeyProvider(provider)) {
            // A saved key without a valid setting cannot be used; report it
            // as not configured rather than as a key that will fail later.
            // Not as the environment's key either: getUserApiKeys does not
            // fall back to it for this user (see unusableProviders).
            const settings = normalizeProviderSettings(provider, row.settings);
            if (!settings) {
                status[provider] = false;
                status.sources[provider] = null;
                continue;
            }
            Object.assign(status.settings, settings);
        }
        status[provider] = row.enabled !== false;
        status.sources[provider] = kind;
    }
}

/** The deployment's own keys: what everybody has before any saved key. */
function envApiKeys(): UserApiKeys {
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
    apiKeys.providerSettings = {
        bedrock: envBedrock ? { region: envBedrock.region } : null,
        azure: envAzure ? { endpoint: envAzure.endpoint } : null,
        "azure-foundry": envAzureFoundry
            ? { endpoint: envAzureFoundry.endpoint }
            : null,
        vertex: envVertex ? { location: envVertex.location } : null,
        custom: null,
    };
    return apiKeys;
}

async function loadKeyRows(
    owner: ApiKeyOwner,
    db: Db,
): Promise<EncryptedKeyRow[]> {
    const { table, column } = OWNER_TABLE[owner.kind];
    const { data, error } = await db
        .from(table)
        .select("provider, encrypted_key, iv, auth_tag, settings, enabled")
        .eq(column, owner.id);
    if (error) {
        if (owner.kind === "org" && isMissingOrgKeySchema(error)) return [];
        throw error;
    }
    return (data ?? []) as EncryptedKeyRow[];
}

// Deploy-before-migrate tolerance for organization keys (20261012_02). A
// direct connection reports a missing table or column as 42P01 / 42703;
// PostgREST reports one missing from its schema cache as PGRST205 /
// PGRST204. Until the migration lands an organization simply has no keys of
// its own and every member runs on theirs, exactly as before it.
function isMissingOrgKeySchema(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code;
    return (
        code === "42P01" ||
        code === "42703" ||
        code === "PGRST205" ||
        code === "PGRST204"
    );
}

/**
 * How an organization's keys apply to one person: null when they do not —
 * the person is not a member, or the organization is gone — and otherwise
 * whether their own keys may sit beneath the organization's.
 */
async function loadOrgKeyScope(
    userId: string,
    orgId: string,
    db: Db,
): Promise<{ allowPersonal: boolean } | null> {
    const [membership, organization] = await Promise.all([
        db
            .from("org_members")
            .select("org_id, organizations!inner(id)")
            .is("organizations.deleted_at", null)
            .eq("org_id", orgId)
            .eq("user_id", userId)
            .maybeSingle(),
        db
            .from("organizations")
            .select("allow_personal_api_keys")
            .eq("id", orgId)
            .maybeSingle(),
    ]);
    if (membership.error) throw membership.error;
    if (organization.error) {
        if (isMissingOrgKeySchema(organization.error)) return null;
        throw organization.error;
    }
    if (!membership.data || !organization.data) return null;
    return {
        allowPersonal:
            (organization.data as { allow_personal_api_keys?: boolean })
                .allow_personal_api_keys !== false,
    };
}

const without = <T,>(
    list: readonly T[] | undefined,
    value: T,
): T[] | undefined => {
    const next = (list ?? []).filter((item) => item !== value);
    return next.length > 0 ? next : undefined;
};

/**
 * Lay one owner's saved keys over `apiKeys`, in place. Each row REPLACES
 * whatever was there for its provider, key and setting together, so a saved
 * key never runs against somebody else's region or resource:
 *
 *   - a usable key takes the provider over
 *   - a disabled key turns the provider off, underlying keys included
 *   - a key whose setting no longer validates makes the provider unusable,
 *     and the keys beneath it must not quietly take its place
 *
 * Any earlier layer's verdict on the provider is cleared first: this owner's
 * row is the newer answer.
 */
function overlayKeyRows(apiKeys: UserApiKeys, rows: EncryptedKeyRow[]): void {
    const providerSettings: ProviderSettings = (apiKeys.providerSettings ??=
        {});
    for (const row of rows) {
        const provider = normalizeApiKeyProvider(row.provider);
        if (!provider) continue;
        if (row.enabled === false) {
            apiKeys[provider] = null;
            apiKeys.unusableProviders = without(
                apiKeys.unusableProviders,
                provider,
            );
            apiKeys.disabledProviders = [
                ...(without(apiKeys.disabledProviders, provider) ?? []),
                provider,
            ];
            if (isSettingsApiKeyProvider(provider)) providerSettings[provider] = null;
            continue;
        }
        const savedKey = decrypt(row)?.trim() || null;
        if (!savedKey) continue;
        apiKeys.disabledProviders = without(apiKeys.disabledProviders, provider);
        apiKeys.unusableProviders = without(apiKeys.unusableProviders, provider);
        if (isSettingsApiKeyProvider(provider)) {
            // The saved key replaces the underlying key AND setting, so it
            // never runs against the operator's region or resource.
            const settings = normalizeProviderSettings(provider, row.settings);
            if (!settings) {
                // The saved key is unusable without its setting, and the
                // pair beneath must not quietly take its place: drop both
                // and mark the provider so cloudProviders.ts does not fall
                // back to the deployment's credentials either.
                apiKeys[provider] = null;
                providerSettings[provider] = null;
                apiKeys.unusableProviders = [
                    ...(apiKeys.unusableProviders ?? []),
                    provider,
                ];
                continue;
            }
            Object.assign(providerSettings, settings);
        }
        apiKeys[provider] = savedKey;
    }
}

export async function getUserApiKeys(
    userId: string,
    db: Db = createServerSupabase(),
): Promise<UserApiKeys> {
    const apiKeys = envApiKeys();
    overlayKeyRows(apiKeys, await loadKeyRows(userKeyOwner(userId), db));
    return apiKeys;
}

/**
 * The keys a piece of work runs on.
 *
 * Personal work (`orgId` null) runs on the caller's keys, as it always has.
 * Work inside an organization runs on the organization's key for a provider
 * when it has one — the firm pays for it, under the firm's terms with the
 * provider. For a provider it has none for, the organization decides:
 *
 *   allow_personal_api_keys = true   the member's own key, then the
 *                                    deployment's
 *   allow_personal_api_keys = false  the deployment's only; a member's
 *                                    personal key never touches the
 *                                    organization's work
 *
 * `orgId` comes from the content being worked on, which the caller has
 * already been authorised for. Membership is checked again here anyway: an
 * organization's key is a credential, and handing it to somebody on the
 * strength of an id alone is the wrong default.
 */
export async function getEffectiveApiKeys(
    userId: string,
    orgId: string | null | undefined,
    db: Db = createServerSupabase(),
): Promise<UserApiKeys> {
    if (!orgId) return getUserApiKeys(userId, db);

    const scope = await loadOrgKeyScope(userId, orgId, db);
    if (!scope) return getUserApiKeys(userId, db);

    const apiKeys = scope.allowPersonal
        ? await getUserApiKeys(userId, db)
        : envApiKeys();
    overlayKeyRows(apiKeys, await loadKeyRows(orgKeyOwner(orgId), db));
    return apiKeys;
}

export function saveUserApiKey(
    userId: string,
    provider: ApiKeyProvider,
    value: string | null,
    db: Db = createServerSupabase(),
    settings: ProviderSettings = {},
): Promise<void> {
    return saveApiKeyFor(userKeyOwner(userId), provider, value, db, settings);
}

/**
 * Save, replace or (with an empty value) remove `owner`'s key for a
 * provider. `savedBy` is recorded on an organization's key, as provenance.
 */
export async function saveApiKeyFor(
    owner: ApiKeyOwner,
    provider: ApiKeyProvider,
    value: string | null,
    db: Db = createServerSupabase(),
    settings: ProviderSettings = {},
    savedBy?: string,
): Promise<void> {
    const { table, column } = OWNER_TABLE[owner.kind];
    const normalized = value?.trim() || null;
    if (!normalized) {
        const { error } = await db
            .from(table)
            .delete()
            .eq(column, owner.id)
            .eq("provider", provider);
        if (error) throw error;
        return;
    }

    const { error } = await db.from(table).upsert(
        {
            [column]: owner.id,
            ...(owner.kind === "org" && savedBy
                ? { updated_by: savedBy }
                : {}),
            provider,
            ...encrypt(normalized),
            settings: isSettingsApiKeyProvider(provider)
                ? (settings[provider] ?? null)
                : null,
            // A new key is a request to use it: without this, ON CONFLICT
            // keeps a previous enabled=false and the provider stays off.
            enabled: true,
            updated_at: new Date().toISOString(),
        },
        { onConflict: `${column},provider` },
    );
    if (error) throw error;
}

/**
 * The raw settings column saved with a key, wrapped so "no key saved"
 * (null) is distinguishable from "a key saved without valid settings".
 */
export async function getSavedApiKeySettings(
    owner: ApiKeyOwner,
    provider: SettingsApiKeyProvider,
    db: Db = createServerSupabase(),
): Promise<{ settings: unknown } | null> {
    const { table, column } = OWNER_TABLE[owner.kind];
    const { data, error } = await db
        .from(table)
        .select("settings")
        .eq(column, owner.id)
        .eq("provider", provider)
        .maybeSingle();
    if (error) throw error;
    return data ? { settings: (data as { settings?: unknown }).settings } : null;
}

/**
 * Change the setting saved with an existing key (a region, endpoint,
 * location or base URL) without re-entering the key. Returns false when the
 * owner has no saved key for the provider.
 */
export async function updateApiKeySettings(
    owner: ApiKeyOwner,
    provider: SettingsApiKeyProvider,
    settings: ProviderSettings,
    db: Db = createServerSupabase(),
): Promise<boolean> {
    const { table, column } = OWNER_TABLE[owner.kind];
    const value = settings[provider];
    if (!value) throw new Error(`Missing ${provider} settings`);
    const { data, error } = await db
        .from(table)
        .update({ settings: value, updated_at: new Date().toISOString() })
        .eq(column, owner.id)
        .eq("provider", provider)
        .select("provider");
    if (error) throw error;
    return (data ?? []).length > 0;
}
