import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    getApiKeyStatusFor,
    getEffectiveApiKeyStatus,
    getEffectiveApiKeys,
    getUserApiKeys,
    loadCourtListenerConnection,
    orgKeyOwner,
    saveApiKeyFor,
    saveCourtListenerConnection,
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
        user_courtlistener_connections: [],
    };
    const errors: Record<string, { code: string; message: string }> = {};

    function query(table: string, mode: "select" | "delete") {
        const filters: [string, unknown][] = [];
        const matches = (row: Row) =>
            filters.every(([column, value]) => (row[column] ?? null) === value);
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
            // The workspace filter: `org_id` eq an id, or is null.
            filter(column: string, _op: string, value: unknown) {
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
                // user_courtlistener_connections: UNIQUE NULLS NOT DISTINCT
                // (user_id, org_id).
                const index = tables[table].findIndex((existing) =>
                    owner
                        ? existing[owner] === row[owner] &&
                          existing.provider === row.provider
                        : existing.user_id === row.user_id &&
                          (existing.org_id ?? null) === (row.org_id ?? null),
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

const firm = () =>
    memoryDb({
        members: [{ org_id: ORG, user_id: USER }],
        organizations: [{ id: ORG }],
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
        const { db, tables } = firm();
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
        const { db } = firm();
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
        const { db, tables } = firm();
        await saveApiKeyFor(userKeyOwner(USER), "openai", "my-key", db);
        await saveApiKeyFor(orgKeyOwner(ORG), "openai", "org-key", db);
        await saveApiKeyFor(orgKeyOwner(ORG), "openai", null, db);

        expect(tables.org_api_keys).toEqual([]);
        expect(tables.user_api_keys).toHaveLength(1);
    });
});

describe("getEffectiveApiKeys", () => {
    it("is the caller's own keys for personal work", async () => {
        const { db } = firm();
        await saveApiKeyFor(userKeyOwner(USER), "openai", "my-key", db);
        await saveApiKeyFor(orgKeyOwner(ORG), "openai", "org-key", db);

        await expect(
            getEffectiveApiKeys(USER, null, db),
        ).resolves.toMatchObject({ openai: "my-key" });
    });

    it("runs organization work on the organization's key, over the member's", async () => {
        const { db } = firm();
        await saveApiKeyFor(userKeyOwner(USER), "openai", "my-key", db);
        await saveApiKeyFor(orgKeyOwner(ORG), "openai", "org-key", db);

        await expect(getEffectiveApiKeys(USER, ORG, db)).resolves.toMatchObject({
            openai: "org-key",
        });
    });

    it("never uses a member's own key for organization work", async () => {
        process.env.GEMINI_API_KEY = "env-gemini";
        const { db } = firm();
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
        const { db, tables } = firm();
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
        const { db, tables } = firm();
        await saveApiKeyFor(userKeyOwner(USER), "openai", "my-key", db);
        tables.user_api_keys[0].enabled = false;
        await saveApiKeyFor(orgKeyOwner(ORG), "openai", "org-key", db);

        const keys = await getEffectiveApiKeys(USER, ORG, db);
        expect(keys.openai).toBe("org-key");
        expect(keys.disabledProviders ?? []).not.toContain("openai");
    });

    it("runs the organization's key against the organization's region, not the member's", async () => {
        const { db } = firm();
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
            organizations: [{ id: ORG }],
        });
        await saveApiKeyFor(userKeyOwner(USER), "claude", "my-claude", db);
        await saveApiKeyFor(orgKeyOwner(ORG), "openai", "org-openai", db);

        const keys = await getEffectiveApiKeys(USER, ORG, db);
        expect(keys.openai).toBeNull();
        expect(keys.claude).toBe("my-claude");
    });

    it("runs on the deployment's keys while the migration has not run", async () => {
        process.env.GEMINI_API_KEY = "env-gemini";
        const { db, errors } = firm();
        await saveApiKeyFor(userKeyOwner(USER), "claude", "my-claude", db);
        errors.org_api_keys = {
            code: "PGRST205",
            message: "Could not find the table 'public.org_api_keys'",
        };

        await expect(getEffectiveApiKeys(USER, ORG, db)).resolves.toMatchObject({
            claude: null,
            gemini: "env-gemini",
        });
        await expect(
            getEffectiveApiKeyStatus(USER, ORG, db),
        ).resolves.toMatchObject({
            claude: false,
            gemini: true,
            sources: { claude: null, gemini: "env" },
        });
    });

    it("still fails loudly on a database error that is not a missing schema", async () => {
        const { db, errors } = firm();
        errors.org_api_keys = { code: "08006", message: "connection failure" };

        await expect(getEffectiveApiKeys(USER, ORG, db)).rejects.toMatchObject({
            code: "08006",
        });
    });
});

describe("getEffectiveApiKeyStatus", () => {
    it("says whose key each provider would run on", async () => {
        process.env.GEMINI_API_KEY = "env-gemini";
        const { db } = firm();
        await saveApiKeyFor(userKeyOwner(USER), "claude", "my-claude", db);
        await saveApiKeyFor(orgKeyOwner(ORG), "openai", "org-openai", db);

        await expect(
            getEffectiveApiKeyStatus(USER, ORG, db),
        ).resolves.toMatchObject({
            openai: true,
            claude: false,
            gemini: true,
            mistral: false,
            sources: { openai: "org", claude: null, gemini: "env" },
        });
    });

    it("agrees with the keys a request would get, provider by provider", async () => {
        process.env.GEMINI_API_KEY = "env-gemini";
        process.env.OPENAI_API_KEY = "env-openai";
        const { db, tables } = firm();
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
            expect([provider, status[provider]]).toEqual([
                provider,
                !!keys[provider],
            ]);
    });

    it("drops the member's setting when the organization's key replaces it", async () => {
        const { db, tables } = firm();
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

describe("CourtListener, per workspace", () => {
    const personal = { userId: USER, orgId: null };
    const inFirm = { userId: USER, orgId: ORG };

    it("keeps a token and a switch for each workspace", async () => {
        const { db } = firm();
        await saveCourtListenerConnection(personal, { token: "personal-token" }, db);
        await saveCourtListenerConnection(inFirm, { enabled: false }, db);

        expect(await loadCourtListenerConnection(personal, db)).toEqual({
            enabled: true,
            token: "personal-token",
        });
        expect(await loadCourtListenerConnection(inFirm, db)).toEqual({
            enabled: false,
            token: null,
        });
    });

    it("runs Personal work on the Personal token and organization work on that workspace's own", async () => {
        const { db } = firm();
        await saveCourtListenerConnection(personal, { token: "personal-token" }, db);

        expect((await getUserApiKeys(USER, db)).courtlistener).toBe("personal-token");
        expect((await getEffectiveApiKeys(USER, ORG, db)).courtlistener).toBeNull();

        await saveCourtListenerConnection(inFirm, { token: "firm-token" }, db);
        expect((await getEffectiveApiKeys(USER, ORG, db)).courtlistener).toBe("firm-token");
        expect((await getEffectiveApiKeys(USER, null, db)).courtlistener).toBe("personal-token");
        expect(
            (await getEffectiveApiKeyStatus(USER, ORG, db)).sources.courtlistener,
        ).toBe("user");
    });

    it("lays the organization's token over the member's", async () => {
        const { db } = firm();
        await saveCourtListenerConnection(inFirm, { token: "firm-token" }, db);
        await saveApiKeyFor(orgKeyOwner(ORG), "courtlistener", "org-token", db);

        expect((await getEffectiveApiKeys(USER, ORG, db)).courtlistener).toBe("org-token");
        expect(
            (await getEffectiveApiKeyStatus(USER, ORG, db)).sources.courtlistener,
        ).toBe("org");
    });

    it("removes a token without forgetting the switch", async () => {
        const { db, tables } = firm();
        await saveCourtListenerConnection(personal, { token: "t", enabled: false }, db);
        await saveCourtListenerConnection(personal, { token: null }, db);

        expect(await loadCourtListenerConnection(personal, db)).toEqual({
            enabled: false,
            token: null,
        });
        expect(tables.user_courtlistener_connections).toHaveLength(1);
    });
});
