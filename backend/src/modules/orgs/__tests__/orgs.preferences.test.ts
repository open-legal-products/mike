import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    role: null as string | null,
    recordAudit: vi.fn(async () => undefined),
}));

vi.mock("../../../lib/access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/access")>()),
    getOrgRole: vi.fn(async () => mocks.role),
}));
vi.mock("../../../lib/audit", () => ({ recordAudit: mocks.recordAudit }));

import {
    getOrgPreferences,
    parseOrgPreferencesUpdate,
    updateOrgPreferences,
} from "../orgs.preferences";

type Row = Record<string, unknown>;

/**
 * One organizations row; reads see it, updates change it and return it. An
 * update filtered on `web_search` lands only while the row still holds that
 * value. `beforeWrite` runs just before each update, as another admin's
 * save landing in between would.
 */
function fakeDb(row: Row | null, beforeWrite?: (row: Row) => void) {
    const updates: Row[] = [];
    const db = {
        from: (table: string) => {
            expect(table).toBe("organizations");
            let patch: Row | null = null;
            const filters: Record<string, unknown> = {};
            const q: Record<string, unknown> = {
                select: () => q,
                eq: (column: string, value: unknown) => {
                    filters[column] = value;
                    return q;
                },
                update: (value: Row) => {
                    patch = value;
                    return q;
                },
                maybeSingle: async () => ({
                    data: row ? { ...row } : null,
                    error: null,
                }),
                then: (resolve: (v: unknown) => unknown) => {
                    if (patch && row) beforeWrite?.(row);
                    const matches =
                        !!row &&
                        (filters.web_search === undefined ||
                            filters.web_search ===
                                JSON.stringify(row.web_search ?? {}));
                    if (patch && row && matches) {
                        updates.push(patch);
                        Object.assign(row, patch);
                    }
                    return Promise.resolve({
                        data: row && matches ? [{ ...row }] : [],
                        error: null,
                    }).then(resolve);
                },
            };
            return q;
        },
    };
    return { db: db as never, updates, row };
}

const update = (db: never, body: unknown) =>
    updateOrgPreferences(db, {
        actorId: "u1",
        actorEmail: "u1@example.com",
        orgId: "org-1",
        body,
    });

beforeEach(() => {
    mocks.role = null;
    mocks.recordAudit.mockClear();
});

describe("getOrgPreferences", () => {
    it("lets any member read them", async () => {
        mocks.role = "member";
        const { db } = fakeDb({ title_model: "claude-haiku-4-5", web_search: { enabled: true } });
        const result = await getOrgPreferences(db, { userId: "u1", orgId: "org-1" });
        expect(result).toMatchObject({
            ok: true,
            preferences: {
                title_model: "claude-haiku-4-5",
                quick_actions_visible: true,
                response_details_visible: false,
                web_search: { enabled: true, claude: "provider", openai: "provider", other: "off" },
            },
        });
    });

    it("says nothing to someone outside the organization", async () => {
        const { db } = fakeDb({});
        await expect(
            getOrgPreferences(db, { userId: "u1", orgId: "org-1" }),
        ).resolves.toEqual({ ok: false, kind: "not_found" });
    });
});

describe("updateOrgPreferences", () => {
    it("refuses a member", async () => {
        mocks.role = "member";
        const { db, updates } = fakeDb({});
        await expect(update(db, { quick_actions_visible: false })).resolves.toEqual({
            ok: false,
            kind: "forbidden",
        });
        expect(updates).toEqual([]);
        expect(mocks.recordAudit).not.toHaveBeenCalled();
    });

    it("says nothing to someone outside the organization", async () => {
        const { db } = fakeDb({});
        await expect(update(db, { quick_actions_visible: false })).resolves.toEqual({
            ok: false,
            kind: "not_found",
        });
    });

    it.each(["admin", "owner"])("lets an %s change them and audits what changed", async (role) => {
        mocks.role = role;
        const { db, updates } = fakeDb({ quick_actions_visible: true });

        const result = await update(db, {
            title_model: "claude-haiku-4-5",
            subagent_reasoning: "high",
            quick_actions_visible: false,
        });

        expect(result).toMatchObject({
            ok: true,
            preferences: {
                title_model: "claude-haiku-4-5",
                subagent_reasoning: "high",
                quick_actions_visible: false,
            },
        });
        expect(updates[0]).toMatchObject({
            title_model: "claude-haiku-4-5",
            subagent_reasoning: "high",
            quick_actions_visible: false,
        });
        expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
        expect(mocks.recordAudit).toHaveBeenCalledWith(
            db,
            expect.objectContaining({
                action: "org.preferences.updated",
                orgId: "org-1",
                detail: { fields: ["title_model", "subagent_reasoning", "quick_actions_visible"] },
            }),
        );
    });

    it("clears a model with null or an empty string", async () => {
        mocks.role = "admin";
        const { db, updates } = fakeDb({ title_model: "claude-haiku-4-5", tabular_model: "gpt-5" });
        await update(db, { title_model: null, tabular_model: "" });
        expect(updates[0]).toMatchObject({ title_model: null, tabular_model: null });
    });

    it("merges web search choices over the stored ones, keeping only those off the default", async () => {
        mocks.role = "admin";
        const { db, updates } = fakeDb({ web_search: { enabled: true, other: "brave" } });

        const result = await update(db, { web_search: { claude: "tavily", other: "off" } });

        // `other` went back to its default, so it is no longer stored.
        expect(updates[0].web_search).toEqual({ enabled: true, claude: "tavily" });
        expect(result).toMatchObject({
            ok: true,
            preferences: {
                web_search: { enabled: true, claude: "tavily", openai: "provider", other: "off" },
            },
        });
    });

    it("re-merges over another admin's web search change that landed first", async () => {
        mocks.role = "admin";
        let raced = false;
        const { db, row } = fakeDb({ web_search: { enabled: true } }, (current) => {
            if (raced) return;
            raced = true;
            // Another admin turns web search off between our read and write.
            current.web_search = {};
        });

        const result = await update(db, { web_search: { claude: "tavily" } });

        expect(row?.web_search).toEqual({ claude: "tavily" });
        expect(result).toMatchObject({
            ok: true,
            preferences: { web_search: { enabled: false, claude: "tavily" } },
        });
    });

    it("answers a conflict when web search keeps changing underneath", async () => {
        mocks.role = "admin";
        let n = 0;
        const { db, updates } = fakeDb({ web_search: {} }, (current) => {
            current.web_search = { other: `brave-${n++}` };
        });

        await expect(
            update(db, { web_search: { enabled: true } }),
        ).resolves.toMatchObject({ ok: false, kind: "conflict" });
        expect(updates).toEqual([]);
        expect(mocks.recordAudit).not.toHaveBeenCalled();
    });

    it("does not audit a save that changed nothing", async () => {
        mocks.role = "admin";
        const { db } = fakeDb({ quick_actions_visible: false });
        await update(db, { quick_actions_visible: false });
        expect(mocks.recordAudit).not.toHaveBeenCalled();
    });

    it("refuses an invalid body without writing", async () => {
        mocks.role = "owner";
        const { db, updates } = fakeDb({});
        await expect(update(db, { title_model: "not-a-model" })).resolves.toMatchObject({
            ok: false,
            kind: "validation",
        });
        expect(updates).toEqual([]);
    });
});

describe("parseOrgPreferencesUpdate", () => {
    it.each([
        ["a non-object", "on"],
        ["an empty object", {}],
        ["an unknown field", { dark_mode: true }],
        ["a model of the wrong type", { tabular_model: 3 }],
        ["an unknown model", { subagent_model: "nonsense-model" }],
        ["an unknown reasoning level", { subagent_reasoning: "extreme" }],
        ["a non-boolean switch", { response_details_visible: "yes" }],
        ["an invalid web search choice", { web_search: { other: "provider" } }],
        ["an unknown web search field", { web_search: { engine: "google" } }],
    ])("refuses %s", (_label, body) => {
        expect(parseOrgPreferencesUpdate(body)).toMatchObject({ ok: false });
    });

    it("accepts every preference", () => {
        expect(
            parseOrgPreferencesUpdate({
                title_model: "claude-haiku-4-5",
                tabular_model: null,
                memory_curator_model: "",
                subagent_model: null,
                subagent_reasoning: null,
                quick_actions_visible: false,
                response_details_visible: true,
                web_search: { enabled: true, openai: "brave" },
            }),
        ).toEqual({
            ok: true,
            update: {
                columns: {
                    title_model: "claude-haiku-4-5",
                    tabular_model: null,
                    memory_curator_model: null,
                    subagent_model: null,
                    subagent_reasoning: null,
                    quick_actions_visible: false,
                    response_details_visible: true,
                },
                webSearch: { enabled: true, openai: "brave" },
            },
        });
    });
});
