import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    getApiKeyStatusFor,
    getEffectiveApiKeyStatus,
    getEffectiveApiKeys,
    getUserApiKeys,
    orgKeyOwner,
    saveApiKeyFor,
    userKeyOwner,
} from "../user.apiKeyStore";

// Whose key a piece of work runs on. The tests go through the real store —
// encryption included — against an in-memory copy of the four tables it
// reads, so what they pin is the layering itself.

type Row = Record<string, unknown>;

const KEY_COLUMN: Record<string, string> = {
    user_api_keys: "user_id",
    org_api_keys: "org_id",
};

function memoryDb(seed: { members?: Row[]; organizations?: Row[] } = {}) {
    const tables: Record<string, Row[]> = {
        user_api_keys: [],
        org_api_keys: [],
        org_members: seed.members ?? [],
        organizations: seed.organizations ?? [],
    };
    const errors: Record<string, { code: string; message: string }> = {};

    function query(table: string, mode: "select" | "delete") {
        const filters: [string, unknown][] = [];
        const matches = (row: Row) =>
            filters.every(([column, value]) => row[column] === value);
        const run = () => {
            if (errors[table]) return { data: null, error: errors[table] };
            const found = tables[table].filter(matches);
            if (mode === "delete")
                tables[table] = tables[table].filter((row) => !matches(row));
            return { data: found, error: null };
        };
        const builder = {
            is: () => builder,
            eq(column: string, value: unknown) {
                filters.push([column, value]);
                return builder;
            },
            async maybeSingle() {
                const result = run();
                return { data: result.data?.[0] ?? null, error: result.error };
            },
            then(
                resolve: (value: ReturnType<typeof run>) => unknown,
                reject?: (reason: unknown) => unknown,
            ) {
                return Promise.resolve(run()).then(resolve, reject);
            },
        };
        return builder;
    }

    const db = {
        from: (table: string) => ({
            select: () => query(table, "select"),
            delete: () => query(table, "delete"),
            // ON CONFLICT (owner, provider) DO UPDATE sets only what is sent.
            upsert: async (row: Row) => {
                const owner = KEY_COLUMN[table];
                const index = tables[table].findIndex(
                    (existing) =>
                        existing[owner] === row[owner] &&
                        existing.provider === row.provider,
                );
                if (index >= 0)
                    tables[table][index] = { ...tables[table][index], ...row };
                else tables[table].push({ enabled: true, ...row });
                return { error: null };
            },
        }),
    };
    return { db: db as never, tables, errors };
}

const USER = "user-1";
const ORG = "org-1";

const firm = (allowPersonal: boolean) =>
    memoryDb({
        members: [{ org_id: ORG, user_id: USER }],
        organizations: [{ id: ORG, allow_personal_api_keys: allowPersonal }],
    });

const ENV_VARS = [
    "ANTHROPIC_API_KEY",
    "CLAUDE_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "MISTRAL_API_KEY",
    "AWS_BEARER_TOKEN_BEDROCK",
    "BEDROCK_AWS_REGION",
    "AWS_REGION",
    "USER_API_KEYS_ENCRYPTION_SECRET",
];

beforeEach(() => {
    for (const name of ENV_VARS) delete process.env[name];
    process.env.USER_API_KEYS_ENCRYPTION_SECRET = "test-secret";
});

afterEach(() => {
    for (const name of ENV_VARS) delete process.env[name];
});

describe("an organization's keys are stored apart from a person's", () => {
    it("writes to the organization's table, with who saved it", async () => {
        const { db, tables } = firm(true);
        await saveApiKeyFor(orgKeyOwner(ORG), "openai", "org-key", db, {}, USER);

        expect(tables.user_api_keys).toEqual([]);
        expect(tables.org_api_keys).toHaveLength(1);
        expect(tables.org_api_keys[0]).toMatchObject({
            org_id: ORG,
            provider: "openai",
            updated_by: USER,
        });
        // Encrypted at rest, like a personal key.
        expect(JSON.stringify(tables.org_api_keys[0])).not.toContain("org-key");
    });

    it("leaves a person's own keys exactly as they were", async () => {
        const { db } = firm(true);
        await saveApiKeyFor(orgKeyOwner(ORG), "openai", "org-key", db);

        await expect(getUserApiKeys(USER, db)).resolves.toMatchObject({
            openai: null,
        });
        await expect(
            getApiKeyStatusFor(userKeyOwner(USER), db),
        ).resolves.toMatchObject({ openai: false });
        await expect(
            getApiKeyStatusFor(orgKeyOwner(ORG), db),
        ).resolves.toMatchObject({ openai: true, sources: { openai: "org" } });
    });

    it("removes the organization's key without touching the member's", async () => {
        const { db, tables } = firm(true);
        await saveApiKeyFor(userKeyOwner(USER), "openai", "my-key", db);
        await saveApiKeyFor(orgKeyOwner(ORG), "openai", "org-key", db);
        await saveApiKeyFor(orgKeyOwner(ORG), "openai", null, db);

        expect(tables.org_api_keys).toEqual([]);
        expect(tables.user_api_keys).toHaveLength(1);
    });
});

describe("getEffectiveApiKeys", () => {
    it("is the caller's own keys for personal work", async () => {
        const { db } = firm(true);
        await saveApiKeyFor(userKeyOwner(USER), "openai", "my-key", db);
        await saveApiKeyFor(orgKeyOwner(ORG), "openai", "org-key", db);

        await expect(
            getEffectiveApiKeys(USER, null, db),
        ).resolves.toMatchObject({ openai: "my-key" });
    });

    it("runs organization work on the organization's key, over the member's", async () => {
        const { db } = firm(true);
        await saveApiKeyFor(userKeyOwner(USER), "openai", "my-key", db);
        await saveApiKeyFor(orgKeyOwner(ORG), "openai", "org-key", db);

        await expect(getEffectiveApiKeys(USER, ORG, db)).resolves.toMatchObject({
            openai: "org-key",
        });
    });

    it("falls back to the member's key for a provider the organization lacks, when allowed", async () => {
        process.env.GEMINI_API_KEY = "env-gemini";
        const { db } = firm(true);
        await saveApiKeyFor(userKeyOwner(USER), "claude", "my-claude", db);
        await saveApiKeyFor(orgKeyOwner(ORG), "openai", "org-openai", db);

        await expect(getEffectiveApiKeys(USER, ORG, db)).resolves.toMatchObject({
            openai: "org-openai",
            claude: "my-claude",
            gemini: "env-gemini",
        });
    });

    it("never uses a member's key when the organization does not allow it", async () => {
        process.env.GEMINI_API_KEY = "env-gemini";
        const { db } = firm(false);
        await saveApiKeyFor(userKeyOwner(USER), "claude", "my-claude", db);
        await saveApiKeyFor(userKeyOwner(USER), "gemini", "my-gemini", db);
        await saveApiKeyFor(orgKeyOwner(ORG), "openai", "org-openai", db);

        const keys = await getEffectiveApiKeys(USER, ORG, db);
        expect(keys.openai).toBe("org-openai");
        expect(keys.claude).toBeNull();
        // The deployment's key still applies; the member's override of it
        // does not.
        expect(keys.gemini).toBe("env-gemini");
        expect(JSON.stringify(keys)).not.toContain("my-");
    });

    it("turns a provider off for the organization when its key is disabled", async () => {
        process.env.OPENAI_API_KEY = "env-openai";
        const { db, tables } = firm(true);
        await saveApiKeyFor(userKeyOwner(USER), "openai", "my-key", db);
        await saveApiKeyFor(orgKeyOwner(ORG), "openai", "org-key", db);
        tables.org_api_keys[0].enabled = false;

        const keys = await getEffectiveApiKeys(USER, ORG, db);
        // Not the member's key and not the deployment's: off means off.
        expect(keys.openai).toBeNull();
        expect(keys.disabledProviders).toEqual(["openai"]);
        // Personal work is untouched by the organization's switch.
        await expect(
            getEffectiveApiKeys(USER, null, db),
        ).resolves.toMatchObject({ openai: "my-key" });
    });

    it("lets the organization's key take over a provider the member disabled", async () => {
        const { db, tables } = firm(true);
        await saveApiKeyFor(userKeyOwner(USER), "openai", "my-key", db);
        tables.user_api_keys[0].enabled = false;
        await saveApiKeyFor(orgKeyOwner(ORG), "openai", "org-key", db);

        const keys = await getEffectiveApiKeys(USER, ORG, db);
        expect(keys.openai).toBe("org-key");
        expect(keys.disabledProviders ?? []).not.toContain("openai");
    });

    it("runs the organization's key against the organization's region, not the member's", async () => {
        const { db } = firm(true);
        await saveApiKeyFor(userKeyOwner(USER), "bedrock", "my-bedrock", db, {
            bedrock: { region: "us-east-1" },
        });
        await saveApiKeyFor(orgKeyOwner(ORG), "bedrock", "org-bedrock", db, {
            bedrock: { region: "eu-west-2" },
        });

        await expect(getEffectiveApiKeys(USER, ORG, db)).resolves.toMatchObject({
            bedrock: "org-bedrock",
            providerSettings: { bedrock: { region: "eu-west-2" } },
        });
    });

    it("does not hand an organization's key to somebody who is not a member", async () => {
        const { db } = memoryDb({
            members: [{ org_id: ORG, user_id: "someone-else" }],
            organizations: [{ id: ORG, allow_personal_api_keys: false }],
        });
        await saveApiKeyFor(userKeyOwner(USER), "claude", "my-claude", db);
        await saveApiKeyFor(orgKeyOwner(ORG), "openai", "org-openai", db);

        const keys = await getEffectiveApiKeys(USER, ORG, db);
        expect(keys.openai).toBeNull();
        expect(keys.claude).toBe("my-claude");
    });

    it("keeps members on their own keys while the migration has not run", async () => {
        const { db, errors } = firm(true);
        await saveApiKeyFor(userKeyOwner(USER), "claude", "my-claude", db);
        errors.organizations = {
            code: "42703",
            message: "column organizations.allow_personal_api_keys does not exist",
        };
        errors.org_api_keys = {
            code: "PGRST205",
            message: "Could not find the table 'public.org_api_keys'",
        };

        await expect(getEffectiveApiKeys(USER, ORG, db)).resolves.toMatchObject({
            claude: "my-claude",
        });
        await expect(
            getEffectiveApiKeyStatus(USER, ORG, db),
        ).resolves.toMatchObject({ claude: true, sources: { claude: "user" } });
    });

    it("still fails loudly on a database error that is not a missing schema", async () => {
        const { db, errors } = firm(true);
        errors.org_api_keys = { code: "08006", message: "connection failure" };

        await expect(getEffectiveApiKeys(USER, ORG, db)).rejects.toMatchObject({
            code: "08006",
        });
    });
});

describe("getEffectiveApiKeyStatus", () => {
    it("says whose key each provider would run on", async () => {
        process.env.GEMINI_API_KEY = "env-gemini";
        const { db } = firm(true);
        await saveApiKeyFor(userKeyOwner(USER), "claude", "my-claude", db);
        await saveApiKeyFor(orgKeyOwner(ORG), "openai", "org-openai", db);

        await expect(
            getEffectiveApiKeyStatus(USER, ORG, db),
        ).resolves.toMatchObject({
            openai: true,
            claude: true,
            gemini: true,
            mistral: false,
            sources: { openai: "org", claude: "user", gemini: "env" },
        });
    });

    it("reports a member's key as unavailable when personal keys are not allowed", async () => {
        const { db } = firm(false);
        await saveApiKeyFor(userKeyOwner(USER), "claude", "my-claude", db);
        await saveApiKeyFor(orgKeyOwner(ORG), "openai", "org-openai", db);

        await expect(
            getEffectiveApiKeyStatus(USER, ORG, db),
        ).resolves.toMatchObject({
            openai: true,
            claude: false,
            sources: { openai: "org", claude: null },
        });
    });

    it("agrees with the keys a request would get, provider by provider", async () => {
        process.env.GEMINI_API_KEY = "env-gemini";
        process.env.OPENAI_API_KEY = "env-openai";
        for (const allowPersonal of [true, false]) {
            const { db, tables } = firm(allowPersonal);
            await saveApiKeyFor(userKeyOwner(USER), "claude", "my-claude", db);
            await saveApiKeyFor(userKeyOwner(USER), "mistral", "my-mistral", db);
            await saveApiKeyFor(orgKeyOwner(ORG), "mistral", "org-mistral", db);
            await saveApiKeyFor(orgKeyOwner(ORG), "openai", "org-openai", db);
            tables.org_api_keys.find(
                (row) => row.provider === "openai",
            )!.enabled = false;

            const keys = await getEffectiveApiKeys(USER, ORG, db);
            const status = await getEffectiveApiKeyStatus(USER, ORG, db);
            for (const provider of [
                "claude",
                "openai",
                "gemini",
                "mistral",
            ] as const)
                expect([allowPersonal, provider, status[provider]]).toEqual([
                    allowPersonal,
                    provider,
                    !!keys[provider],
                ]);
        }
    });

    it("drops the member's setting when the organization's key replaces it", async () => {
        const { db, tables } = firm(true);
        await saveApiKeyFor(userKeyOwner(USER), "bedrock", "my-bedrock", db, {
            bedrock: { region: "us-east-1" },
        });
        await saveApiKeyFor(orgKeyOwner(ORG), "bedrock", "org-bedrock", db, {
            bedrock: { region: "eu-west-2" },
        });

        await expect(
            getEffectiveApiKeyStatus(USER, ORG, db),
        ).resolves.toMatchObject({
            settings: { bedrock: { region: "eu-west-2" } },
        });

        // Switched off, the row still describes the organization's saved
        // key — never the member's region underneath it.
        tables.org_api_keys[0].enabled = false;
        const status = await getEffectiveApiKeyStatus(USER, ORG, db);
        expect(status.bedrock).toBe(false);
        expect(JSON.stringify(status.settings)).not.toContain("us-east-1");
    });
});
