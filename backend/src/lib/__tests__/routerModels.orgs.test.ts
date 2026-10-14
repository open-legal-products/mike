import { describe, expect, it, vi } from "vitest";
import {
    getAllOrgRouterModels,
    getEffectiveRouterModels,
    replaceOrgRouterModels,
    resolveRequestedModel,
} from "../routerModels";

// Whose model list governs a request. A router's list belongs to whoever's
// key it runs on: the organization's where it holds that router's key, and
// otherwise the member's own.

type Row = Record<string, unknown>;
type DbError = { code: string; message: string };

function memoryDb(seed: Record<string, Row[]>) {
    const tables: Record<string, Row[]> = {
        user_router_models: [],
        org_router_models: [],
        org_api_keys: [],
        org_members: [],
        ...seed,
    };
    const errors: Record<string, DbError> = {};
    const rpc = vi.fn(async (..._args: unknown[]) => ({ error: null }));
    const db = {
        rpc,
        from: (table: string) => {
            const filters: [string, unknown][] = [];
            const run = () =>
                errors[table]
                    ? { data: null, error: errors[table] }
                    : {
                          data: tables[table].filter((row) =>
                              filters.every(([c, v]) => row[c] === v),
                          ),
                          error: null,
                      };
            const query = {
                select: () => query,
                is: () => query,
                order: () => query,
                eq(column: string, value: unknown) {
                    filters.push([column, value]);
                    return query;
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
            return query;
        },
    };
    return { db: db as never, tables, errors, rpc };
}

const USER = "user-1";
const ORG = "org-1";
const own = (router: string, model: string): Row => ({
    user_id: USER,
    router,
    model_id: model,
});
const firms = (router: string, model: string): Row => ({
    org_id: ORG,
    router,
    model_id: model,
});

/** A member of a firm that holds an OpenRouter key and no Vercel key. */
const firm = (extra: Record<string, Row[]> = {}) =>
    memoryDb({
        org_members: [{ org_id: ORG, user_id: USER }],
        org_api_keys: [{ org_id: ORG, provider: "openrouter" }],
        user_router_models: [
            own("openrouter", "mine/or-model"),
            own("vercel", "mine/vercel-model"),
        ],
        org_router_models: [
            firms("openrouter", "firm/or-model"),
            // A list for a router whose key the firm does not hold.
            firms("vercel", "firm/vercel-model"),
        ],
        ...extra,
    });

describe("getAllOrgRouterModels", () => {
    it("groups an organization's lists by router and ignores unknown ones", async () => {
        const { db } = memoryDb({
            org_router_models: [
                firms("openrouter", "a/one"),
                firms("openrouter", " b/two "),
                firms("bedrock", "us.anthropic.claude"),
                firms("not-a-router", "x"),
                { org_id: "other-org", router: "openrouter", model_id: "z/other" },
            ],
        });

        const lists = await getAllOrgRouterModels(ORG, db);

        expect(lists.openrouter).toEqual(["a/one", "b/two"]);
        expect(lists.bedrock).toEqual(["us.anthropic.claude"]);
        expect(lists.vercel).toEqual([]);
    });

    it("reads as empty until the migration has run", async () => {
        const { db, errors } = memoryDb({});
        errors.org_router_models = {
            code: "PGRST205",
            message: "Could not find the table 'public.org_router_models'",
        };
        await expect(getAllOrgRouterModels(ORG, db)).resolves.toMatchObject({
            openrouter: [],
        });
    });

    it("still fails on a database error that is not a missing table", async () => {
        const { db, errors } = memoryDb({});
        errors.org_router_models = { code: "08006", message: "connection failure" };
        await expect(getAllOrgRouterModels(ORG, db)).rejects.toMatchObject({
            code: "08006",
        });
    });
});

describe("getEffectiveRouterModels", () => {
    it("is the caller's own lists for personal work", async () => {
        const { db } = firm();
        const lists = await getEffectiveRouterModels(USER, null, db);
        expect(lists.openrouter).toEqual(["mine/or-model"]);
        expect(lists.vercel).toEqual(["mine/vercel-model"]);
    });

    it("uses the organization's list for a router whose key it holds, and the member's for the rest", async () => {
        const { db } = firm();

        const lists = await getEffectiveRouterModels(USER, ORG, db);

        expect(lists.openrouter).toEqual(["firm/or-model"]);
        // No Vercel key at the firm, so its Vercel list governs nothing.
        expect(lists.vercel).toEqual(["mine/vercel-model"]);
    });

    it("lets an organization's empty list stand: its key runs nothing until models are added", async () => {
        const { db } = firm({ org_router_models: [] });
        const lists = await getEffectiveRouterModels(USER, ORG, db);
        // Not the member's own list: that would let them choose what the
        // firm's key is spent on.
        expect(lists.openrouter).toEqual([]);
    });

    it("does not put a non-member under an organization's lists", async () => {
        const { db } = firm({ org_members: [] });
        const lists = await getEffectiveRouterModels(USER, ORG, db);
        expect(lists.openrouter).toEqual(["mine/or-model"]);
    });

    it("keeps members on their own lists while the migration has not run", async () => {
        const { db, errors } = firm();
        errors.org_api_keys = {
            code: "42P01",
            message: 'relation "public.org_api_keys" does not exist',
        };
        const lists = await getEffectiveRouterModels(USER, ORG, db);
        expect(lists.openrouter).toEqual(["mine/or-model"]);
    });
});

describe("resolveRequestedModel inside an organization", () => {
    it("accepts a model on the organization's list that the member never saved", async () => {
        const { db } = firm();
        await expect(
            resolveRequestedModel(
                "openrouter/firm/or-model",
                "",
                USER,
                db,
                "throw",
                ORG,
            ),
        ).resolves.toBe("openrouter/firm/or-model");
    });

    it("refuses a model only on the member's own list, and says who can add it", async () => {
        const { db } = firm();
        await expect(
            resolveRequestedModel(
                "openrouter/mine/or-model",
                "",
                USER,
                db,
                "throw",
                ORG,
            ),
        ).rejects.toThrow(/organization's saved OpenRouter models.*admin/);
    });

    it("still judges a router the organization has no key for against the member's list", async () => {
        const { db } = firm();
        await expect(
            resolveRequestedModel(
                "vercel/mine/vercel-model",
                "",
                USER,
                db,
                "throw",
                ORG,
            ),
        ).resolves.toBe("vercel/mine/vercel-model");
        await expect(
            resolveRequestedModel(
                "vercel/firm/vercel-model",
                "",
                USER,
                db,
                "throw",
                ORG,
            ),
        ).rejects.toThrow(/your saved Vercel AI Gateway models/);
    });

    it("leaves personal work on the member's own list", async () => {
        const { db } = firm();
        await expect(
            resolveRequestedModel("openrouter/mine/or-model", "", USER, db, "throw"),
        ).resolves.toBe("openrouter/mine/or-model");
        await expect(
            resolveRequestedModel("openrouter/firm/or-model", "", USER, db, "throw"),
        ).rejects.toThrow(/your saved OpenRouter models/);
    });

    it("degrades a stale stored preference to the fallback instead of failing", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { db } = firm();
        await expect(
            resolveRequestedModel(
                "openrouter/mine/or-model",
                "",
                USER,
                db,
                "fallback",
                ORG,
            ),
        ).resolves.toBe("");
        warn.mockRestore();
    });
});

describe("replaceOrgRouterModels", () => {
    it("replaces one router's list through the database function", async () => {
        const { db, rpc } = memoryDb({});
        await replaceOrgRouterModels(ORG, "bedrock", ["us.anthropic.claude"], db);
        expect(rpc).toHaveBeenCalledExactlyOnceWith("replace_org_router_models", {
            target_org_id: ORG,
            target_router: "bedrock",
            target_model_ids: ["us.anthropic.claude"],
        });
    });

    it("surfaces a failed replace", async () => {
        const { db, rpc } = memoryDb({});
        rpc.mockResolvedValueOnce({ error: { message: "boom" } } as never);
        await expect(
            replaceOrgRouterModels(ORG, "bedrock", [], db),
        ).rejects.toMatchObject({ message: "boom" });
    });
});
