import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    normalizeApiKeyProvider,
    hasEnvApiKey,
    getUserApiKeys,
    getUserApiKeyStatus,
    saveUserApiKey,
} from "../user.apiKeyStore";

describe("normalizeApiKeyProvider", () => {
    it('returns "claude" for "claude"', () => {
        expect(normalizeApiKeyProvider("claude")).toBe("claude");
    });

    it('returns "openai" for "openai"', () => {
        expect(normalizeApiKeyProvider("openai")).toBe("openai");
    });

    it('returns "gemini" for "gemini"', () => {
        expect(normalizeApiKeyProvider("gemini")).toBe("gemini");
    });

    it("accepts the direct Mistral provider", () => {
        expect(normalizeApiKeyProvider("mistral")).toBe("mistral");
    });

    it("returns the supported router providers", () => {
        expect(normalizeApiKeyProvider("openrouter")).toBe("openrouter");
        expect(normalizeApiKeyProvider("vercel")).toBe("vercel");
        expect(normalizeApiKeyProvider("opencode-go")).toBe("opencode-go");
    });

    it("returns null for unknown provider strings", () => {
        expect(normalizeApiKeyProvider("unknown")).toBeNull();
        expect(normalizeApiKeyProvider("")).toBeNull();
        expect(normalizeApiKeyProvider("Claude")).toBeNull();
        expect(normalizeApiKeyProvider("OPENAI")).toBeNull();
    });
});

describe("hasEnvApiKey", () => {
    const envVars = [
        "ANTHROPIC_API_KEY",
        "CLAUDE_API_KEY",
        "OPENAI_API_KEY",
        "MISTRAL_API_KEY",
        "GEMINI_API_KEY",
        "OPENROUTER_API_KEY",
        "AI_GATEWAY_API_KEY",
        "VERCEL_AI_GATEWAY_API_KEY",
        "OPENCODE_API_KEY",
        "USER_API_KEYS_ENCRYPTION_SECRET",
    ];

    // Clear before AND after each test so keys exported in the developer's
    // shell (or CI) can't leak into assertions.
    beforeEach(() => {
        for (const v of envVars) delete process.env[v];
    });

    afterEach(() => {
        for (const v of envVars) delete process.env[v];
    });

    it("returns true for claude when ANTHROPIC_API_KEY is set", () => {
        process.env.ANTHROPIC_API_KEY = "sk-ant-test";
        expect(hasEnvApiKey("claude")).toBe(true);
    });

    it("returns true for claude when CLAUDE_API_KEY is set as fallback", () => {
        process.env.CLAUDE_API_KEY = "sk-claude-test";
        expect(hasEnvApiKey("claude")).toBe(true);
    });

    it("returns true for openai when OPENAI_API_KEY is set", () => {
        process.env.OPENAI_API_KEY = "sk-openai-test";
        expect(hasEnvApiKey("openai")).toBe(true);
    });

    it("returns true for gemini when GEMINI_API_KEY is set", () => {
        process.env.GEMINI_API_KEY = "gemini-key-test";
        expect(hasEnvApiKey("gemini")).toBe(true);
    });

    it("returns true for Vercel when AI_GATEWAY_API_KEY is set", () => {
        process.env.AI_GATEWAY_API_KEY = "vercel-key-test";
        expect(hasEnvApiKey("vercel")).toBe(true);
    });

    it("accepts VERCEL_AI_GATEWAY_API_KEY as a compatibility alias", () => {
        process.env.VERCEL_AI_GATEWAY_API_KEY = "vercel-key-test";
        expect(hasEnvApiKey("vercel")).toBe(true);
    });

    it("returns true for OpenCode Go when OPENCODE_API_KEY is set", () => {
        process.env.OPENCODE_API_KEY = "opencode-key-test";
        expect(hasEnvApiKey("opencode-go")).toBe(true);
    });

    it("returns false when no env key is set for the provider", () => {
        expect(hasEnvApiKey("claude")).toBe(false);
        expect(hasEnvApiKey("openai")).toBe(false);
        expect(hasEnvApiKey("gemini")).toBe(false);
    });

    it("ignores whitespace-only env values", () => {
        process.env.ANTHROPIC_API_KEY = "   ";
        expect(hasEnvApiKey("claude")).toBe(false);
    });
});

describe("user API key precedence", () => {
    it.each(["openai", "mistral"] as const)("uses a saved %s key before an environment key", async (provider) => {
        const environmentVariable = provider === "mistral" ? "MISTRAL_API_KEY" : "OPENAI_API_KEY";
        process.env[environmentVariable] = "environment-key";
        process.env.USER_API_KEYS_ENCRYPTION_SECRET = "test-secret";
        let savedRow: Record<string, unknown> | null = null;
        const db = {
            from: () => ({
                upsert: async (row: Record<string, unknown>) => {
                    savedRow = { ...row, provider };
                    return { error: null };
                },
                delete: () => ({
                    eq: () => ({ eq: async () => { savedRow = null; return { error: null }; } }),
                }),
                select: () => ({
                    eq: async () => ({
                        data: savedRow ? [savedRow] : [],
                        error: null,
                    }),
                }),
            }),
        };

        await expect(getUserApiKeyStatus("user-1", db as never)).resolves.toMatchObject({
            [provider]: true, sources: { [provider]: "env" },
        });
        await saveUserApiKey("user-1", provider, "personal-key", db as never);
        expect(savedRow).not.toHaveProperty("encrypted_key", "personal-key");

        await expect(getUserApiKeys("user-1", db as never)).resolves.toMatchObject({
            [provider]: "personal-key",
        });
        await expect(
            getUserApiKeyStatus("user-1", db as never),
        ).resolves.toMatchObject({
            [provider]: true,
            sources: { [provider]: "user" },
        });

        await saveUserApiKey("user-1", provider, null, db as never);
        await expect(getUserApiKeys("user-1", db as never)).resolves.toMatchObject({ [provider]: "environment-key" });
        await expect(getUserApiKeyStatus("user-1", db as never)).resolves.toMatchObject({ [provider]: true, sources: { [provider]: "env" } });
        delete process.env[environmentVariable];
        delete process.env.USER_API_KEYS_ENCRYPTION_SECRET;
    });
});

describe("cloud-platform keys", () => {
    const envVars = [
        "AWS_BEARER_TOKEN_BEDROCK",
        "BEDROCK_AWS_REGION",
        "AWS_REGION",
        "AZURE_API_KEY",
        "AZURE_OPENAI_ENDPOINT",
        "AZURE_RESOURCE_NAME",
        "AZURE_FOUNDRY_API_KEY",
        "AZURE_FOUNDRY_ENDPOINT",
        "GOOGLE_VERTEX_CREDENTIALS_JSON",
        "GOOGLE_VERTEX_LOCATION",
        "XAI_API_KEY",
        "USER_API_KEYS_ENCRYPTION_SECRET",
    ];

    beforeEach(() => {
        for (const v of envVars) delete process.env[v];
        process.env.USER_API_KEYS_ENCRYPTION_SECRET = "test-secret";
    });

    afterEach(() => {
        for (const v of envVars) delete process.env[v];
    });

    function memoryDb() {
        const rows = new Map<string, Record<string, unknown>>();
        return {
            rows,
            db: {
                from: () => ({
                    upsert: async (row: Record<string, unknown>) => {
                        rows.set(String(row.provider), row);
                        return { error: null };
                    },
                    delete: () => ({
                        eq: () => ({
                            eq: async (_column: string, provider: string) => {
                                rows.delete(provider);
                                return { error: null };
                            },
                        }),
                    }),
                    select: () => ({
                        eq: async () => ({ data: [...rows.values()], error: null }),
                    }),
                }),
            } as never,
        };
    }

    it("accepts the Bedrock and Azure providers", () => {
        expect(normalizeApiKeyProvider("bedrock")).toBe("bedrock");
        expect(normalizeApiKeyProvider("azure")).toBe("azure");
    });

    it("counts an environment key only when its region or endpoint is set too", () => {
        process.env.AWS_BEARER_TOKEN_BEDROCK = "env-bedrock";
        process.env.AZURE_API_KEY = "env-azure";
        expect(hasEnvApiKey("bedrock")).toBe(false);
        expect(hasEnvApiKey("azure")).toBe(false);

        process.env.AWS_REGION = "us-west-2";
        process.env.AZURE_RESOURCE_NAME = "contoso-openai";
        expect(hasEnvApiKey("bedrock")).toBe(true);
        expect(hasEnvApiKey("azure")).toBe(true);
    });

    it("saves the setting with the key and replaces the environment's pair", async () => {
        process.env.AWS_BEARER_TOKEN_BEDROCK = "env-bedrock";
        process.env.BEDROCK_AWS_REGION = "us-east-1";
        const { db, rows } = memoryDb();

        await expect(getUserApiKeys("user-1", db)).resolves.toMatchObject({
            bedrock: "env-bedrock",
            providerSettings: { bedrock: { region: "us-east-1" } },
        });

        await saveUserApiKey("user-1", "bedrock", "user-bedrock", db, {
            bedrock: { region: "eu-west-2" },
        });
        expect(rows.get("bedrock")).toMatchObject({
            settings: { region: "eu-west-2" },
        });
        expect(rows.get("bedrock")).not.toHaveProperty(
            "encrypted_key",
            "user-bedrock",
        );

        await expect(getUserApiKeys("user-1", db)).resolves.toMatchObject({
            bedrock: "user-bedrock",
            providerSettings: { bedrock: { region: "eu-west-2" } },
        });
        await expect(getUserApiKeyStatus("user-1", db)).resolves.toMatchObject({
            bedrock: true,
            sources: { bedrock: "user" },
            settings: { bedrock: { region: "eu-west-2" } },
        });
    });

    const serviceAccount = JSON.stringify({
        type: "service_account",
        project_id: "legal-prod",
        private_key: "-----BEGIN PRIVATE KEY-----",
        client_email: "mike@legal-prod.iam.gserviceaccount.com",
    });

    it("accepts the Vertex, Foundry, xAI and custom-endpoint providers", () => {
        for (const provider of ["vertex", "azure-foundry", "xai", "custom"]) {
            expect(normalizeApiKeyProvider(provider)).toBe(provider);
        }
    });

    it("counts the new environment keys only when they are usable", () => {
        process.env.GOOGLE_VERTEX_CREDENTIALS_JSON = serviceAccount;
        process.env.AZURE_FOUNDRY_API_KEY = "env-foundry";
        expect(hasEnvApiKey("vertex")).toBe(false);
        expect(hasEnvApiKey("azure-foundry")).toBe(false);

        process.env.GOOGLE_VERTEX_LOCATION = "us-central1";
        process.env.AZURE_FOUNDRY_ENDPOINT = "contoso-foundry";
        process.env.XAI_API_KEY = "env-xai";
        expect(hasEnvApiKey("vertex")).toBe(true);
        expect(hasEnvApiKey("azure-foundry")).toBe(true);
        expect(hasEnvApiKey("xai")).toBe(true);

        // A value that is not a key file is not a configured deployment key.
        process.env.GOOGLE_VERTEX_CREDENTIALS_JSON = "AIzaSy-plain-key";
        expect(hasEnvApiKey("vertex")).toBe(false);
        // A custom endpoint is only ever the user's own.
        expect(hasEnvApiKey("custom")).toBe(false);
    });

    it("stores each new key with its own setting and reads the pair back", async () => {
        process.env.GOOGLE_VERTEX_CREDENTIALS_JSON = serviceAccount;
        process.env.GOOGLE_VERTEX_LOCATION = "europe-west4";
        const { db, rows } = memoryDb();

        await saveUserApiKey("user-1", "vertex", serviceAccount, db, {
            vertex: { location: "us-central1" },
        });
        await saveUserApiKey("user-1", "azure-foundry", "foundry-key", db, {
            "azure-foundry": {
                endpoint: "https://contoso.services.ai.azure.com",
            },
        });
        await saveUserApiKey("user-1", "custom", "sk-custom", db, {
            custom: { baseUrl: "https://llm.example.com/v1" },
        });
        await saveUserApiKey("user-1", "xai", "xai-key", db);

        expect(rows.get("vertex")?.settings).toEqual({ location: "us-central1" });
        expect(rows.get("xai")?.settings).toBeNull();
        expect(JSON.stringify([...rows.values()])).not.toContain("PRIVATE KEY");

        await expect(getUserApiKeys("user-1", db)).resolves.toMatchObject({
            vertex: serviceAccount,
            "azure-foundry": "foundry-key",
            custom: "sk-custom",
            xai: "xai-key",
            providerSettings: {
                vertex: { location: "us-central1" },
                "azure-foundry": {
                    endpoint: "https://contoso.services.ai.azure.com",
                },
                custom: { baseUrl: "https://llm.example.com/v1" },
            },
        });
        await expect(getUserApiKeyStatus("user-1", db)).resolves.toMatchObject({
            vertex: true,
            custom: true,
            sources: { vertex: "user", "azure-foundry": "user", xai: "user" },
            settings: { custom: { baseUrl: "https://llm.example.com/v1" } },
        });
    });

    it("treats a custom endpoint whose saved URL is no longer acceptable as not configured", async () => {
        const { db, rows } = memoryDb();
        await saveUserApiKey("user-1", "custom", "sk-custom", db, {
            custom: { baseUrl: "https://llm.example.com/v1" },
        });
        rows.get("custom")!.settings = { baseUrl: "https://10.0.0.5/v1" };

        const keys = await getUserApiKeys("user-1", db);
        expect(keys.custom).toBeNull();
        await expect(getUserApiKeyStatus("user-1", db)).resolves.toMatchObject({
            custom: false,
        });
    });

    it("does not echo the deployment's endpoint back in status", async () => {
        process.env.AZURE_API_KEY = "env-azure";
        process.env.AZURE_OPENAI_ENDPOINT = "operator-openai";
        const { db } = memoryDb();

        const status = await getUserApiKeyStatus("user-1", db);
        expect(status).toMatchObject({ azure: true, sources: { azure: "env" } });
        expect(status.settings).toEqual({});
    });

    it("keeps a disabled key encrypted and restores it when re-enabled without falling back to the server", async () => {
        process.env.AWS_BEARER_TOKEN_BEDROCK = "env-bedrock";
        process.env.BEDROCK_AWS_REGION = "us-east-1";
        const { db, rows } = memoryDb();
        await saveUserApiKey("user-1", "bedrock", "personal-key", db, {
            bedrock: { region: "eu-west-2" },
        });
        const stored = { ...rows.get("bedrock") };
        rows.set("bedrock", { ...stored, enabled: false });

        await expect(getUserApiKeyStatus("user-1", db)).resolves.toMatchObject({
            bedrock: false,
            sources: { bedrock: "user" },
            enabled: { bedrock: false },
            settings: { bedrock: { region: "eu-west-2" } },
        });
        await expect(getUserApiKeys("user-1", db)).resolves.toMatchObject({
            bedrock: null,
            disabledProviders: ["bedrock"],
            providerSettings: { bedrock: null },
        });
        expect(rows.get("bedrock")).toMatchObject(stored);

        rows.set("bedrock", { ...stored, enabled: true });
        await expect(getUserApiKeys("user-1", db)).resolves.toMatchObject({
            bedrock: "personal-key",
            providerSettings: { bedrock: { region: "eu-west-2" } },
        });
    });

    it("ignores a saved cloud key whose setting is missing or invalid", async () => {
        const { db, rows } = memoryDb();
        await saveUserApiKey("user-1", "azure", "user-azure", db, {
            azure: { endpoint: "contoso-openai" },
        });
        rows.set("azure", {
            ...rows.get("azure"),
            settings: { endpoint: "https://attacker.example" },
        });

        await expect(getUserApiKeys("user-1", db)).resolves.toMatchObject({
            azure: null,
            providerSettings: { azure: null },
        });
        await expect(getUserApiKeyStatus("user-1", db)).resolves.toMatchObject({
            azure: false,
            sources: { azure: null },
        });
    });
});
