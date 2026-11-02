import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Response } from "express";
import {
    PERSONAL_WORKSPACE,
    resolveWorkspaceFilter,
    sendWorkspaceFailure,
    workspaceRpcArg,
} from "../workspace";
import { scriptedDb } from "../../__tests__/helpers/scriptedDb";
import {
    buildProjectIdsOverviewRpcArgs,
    buildProjectsOverviewRpcArgs,
} from "../../modules/projects/projects.overview";
import {
    buildWorkflowIdsOverviewRpcArgs,
    buildWorkflowsOverviewRpcArgs,
} from "../../modules/workflows/workflows.overview";
import {
    buildTabularReviewIdsOverviewRpcArgs,
    buildTabularReviewsOverviewRpcArgs,
} from "../../modules/tabular/tabular.overview";
import { listChats } from "../../modules/chat/chat.crud";
import {
    listTabularReviewIds,
    listTabularReviews,
} from "../../modules/tabular/tabular.reviews";
import {
    getWorkflowFilterOptions,
    listWorkflowIds,
} from "../../modules/workflows/workflows.listing";

const ORG = "7b1d9d0e-3c5a-4f6e-9a51-0c2f7d3e8a11";

describe("resolveWorkspaceFilter", () => {
    it.each([undefined, null, ""])(
        "does not narrow, or touch the database, for %j",
        async (raw) => {
            const fake = scriptedDb([]);
            await expect(
                resolveWorkspaceFilter(fake.db, "u1", raw),
            ).resolves.toEqual({ ok: true, workspace: null });
            fake.done();
        },
    );

    it("accepts the personal workspace without a membership lookup", async () => {
        const fake = scriptedDb([]);
        await expect(
            resolveWorkspaceFilter(fake.db, "u1", PERSONAL_WORKSPACE),
        ).resolves.toEqual({ ok: true, workspace: "personal" });
        fake.done();
    });

    it("accepts an organization the caller belongs to, scoped to that caller", async () => {
        const fake = scriptedDb([
            { table: "org_members", data: { org_id: ORG } },
            { table: "organizations", data: { kind: "team" } },
        ]);
        await expect(
            resolveWorkspaceFilter(fake.db, "u1", ORG.toUpperCase()),
        ).resolves.toEqual({ ok: true, workspace: ORG });
        // The lookup is for THIS user in THIS organization, not "does the
        // organization exist".
        expect(fake.calls[0].filters).toEqual([
            ["is", "organizations.deleted_at", null],
            ["eq", "org_id", ORG],
            ["eq", "user_id", "u1"],
        ]);
        fake.done();
    });

    it("reports an organization the caller is not in as missing", async () => {
        const fake = scriptedDb([
            { table: "org_members", data: null },
            { table: "organizations", data: { kind: "team" } },
        ]);
        await expect(
            resolveWorkspaceFilter(fake.db, "u1", ORG),
        ).resolves.toEqual({ ok: false, kind: "not_found" });
        fake.done();
    });

    it("reports the caller's own personal organization as missing: it is reached as 'personal'", async () => {
        const fake = scriptedDb([
            { table: "org_members", data: { org_id: ORG } },
            { table: "organizations", data: { kind: "personal" } },
        ]);
        await expect(
            resolveWorkspaceFilter(fake.db, "u1", ORG),
        ).resolves.toEqual({ ok: false, kind: "not_found" });
        expect(fake.calls[1].filters).toEqual([["eq", "id", ORG]]);
        fake.done();
    });

    it("throws when the organization's kind cannot be read, instead of letting it through", async () => {
        const fake = scriptedDb([
            { table: "org_members", data: { org_id: ORG } },
            { table: "organizations", error: { message: "connection reset" } },
        ]);
        await expect(
            resolveWorkspaceFilter(fake.db, "u1", ORG),
        ).rejects.toThrow("Failed to read the organization's kind");
        fake.done();
    });

    it.each([
        "everything",
        "Personal",
        "7b1d9d0e-3c5a-4f6e-9a51",
        `${ORG}' or '1'='1`,
        ["personal"],
        { id: ORG },
        42,
    ])("rejects %j before it reaches the database", async (raw) => {
        // The value is cast to uuid inside the list RPCs, so anything that is
        // not one must stop here rather than surface as a Postgres error.
        const fake = scriptedDb([]);
        await expect(
            resolveWorkspaceFilter(fake.db, "u1", raw),
        ).resolves.toEqual({ ok: false, kind: "validation" });
        fake.done();
    });

    it("throws when membership cannot be read, instead of answering 'not found'", async () => {
        // The client falls back to Personal on "not found". A database blip
        // must not move somebody out of their firm's workspace.
        const fake = scriptedDb([
            { table: "org_members", error: { message: "connection reset" } },
            { table: "organizations", data: { kind: "team" } },
        ]);
        await expect(
            resolveWorkspaceFilter(fake.db, "u1", ORG),
        ).rejects.toThrow("Failed to resolve the active workspace");
    });
});

describe("sendWorkspaceFailure", () => {
    function response() {
        const json = vi.fn();
        const status = vi.fn(() => ({ json }));
        return { res: { status } as unknown as Response, status, json };
    }

    it("answers a malformed workspace with 400", () => {
        const { res, status, json } = response();
        sendWorkspaceFailure(res, { ok: false, kind: "validation" });
        expect(status).toHaveBeenCalledWith(400);
        expect(json).toHaveBeenCalledWith({
            detail: "workspace must be 'personal' or an organization id",
        });
    });

    it("answers a workspace the caller cannot use with a 404 the client can recognise", () => {
        const { res, status, json } = response();
        sendWorkspaceFailure(res, { ok: false, kind: "not_found" });
        expect(status).toHaveBeenCalledWith(404);
        expect(json).toHaveBeenCalledWith({
            detail: "Workspace not found",
            code: "workspace_not_found",
        });
    });
});

describe("workspace RPC argument", () => {
    it("is omitted when the list is not narrowed", () => {
        // A request that names no workspace must call the RPC exactly as it
        // did before the parameter existed.
        expect(workspaceRpcArg(null)).toEqual({});
        expect(workspaceRpcArg(undefined)).toEqual({});
        expect(workspaceRpcArg("personal")).toEqual({
            p_workspace: "personal",
        });
        expect(workspaceRpcArg(ORG)).toEqual({ p_workspace: ORG });
    });

    const base = { userId: "u1", userEmail: "u1@example.com" };
    const page = { limit: 10, offset: 0 };
    const builders: [string, (workspace?: string | null) => object][] = [
        [
            "projects",
            (workspace) => buildProjectsOverviewRpcArgs({ ...base, workspace }),
        ],
        [
            "project ids",
            (workspace) =>
                buildProjectIdsOverviewRpcArgs({
                    ...base,
                    pagination: page,
                    workspace,
                }),
        ],
        [
            "workflows",
            (workspace) => buildWorkflowsOverviewRpcArgs({ ...base, workspace }),
        ],
        [
            "workflow ids",
            (workspace) =>
                buildWorkflowIdsOverviewRpcArgs({
                    ...base,
                    pagination: page,
                    workspace,
                }),
        ],
        [
            "tabular reviews",
            (workspace) =>
                buildTabularReviewsOverviewRpcArgs({
                    ...base,
                    projectIdFilter: null,
                    workspace,
                }),
        ],
        [
            "tabular review ids",
            (workspace) =>
                buildTabularReviewIdsOverviewRpcArgs({
                    ...base,
                    projectIdFilter: null,
                    pagination: page,
                    workspace,
                }),
        ],
    ];

    it.each(builders)("the %s builder forwards it and only it", (_name, build) => {
        const unscoped = build();
        expect(unscoped).not.toHaveProperty("p_workspace");
        expect(build(null)).toEqual(unscoped);
        expect(build(ORG)).toEqual({ ...unscoped, p_workspace: ORG });
        expect(build("personal")).toEqual({
            ...unscoped,
            p_workspace: "personal",
        });
    });
});

describe("list services hand the workspace to their RPC", () => {
    const who = { userId: "u1", userEmail: "u1@example.com" };

    it("chats", async () => {
        const fake = scriptedDb([{ rpc: "get_chats_overview", data: [] }]);
        await listChats(fake.db, {
            ...who,
            limit: 20,
            offset: 0,
            beforeUpdatedAt: null,
            beforeId: null,
            workspace: ORG,
        });
        expect(fake.calls[0].args).toMatchObject({ p_workspace: ORG });
        fake.done();
    });

    it("chats, unscoped, send no workspace at all", async () => {
        const fake = scriptedDb([{ rpc: "get_chats_overview", data: [] }]);
        await listChats(fake.db, {
            ...who,
            limit: 20,
            offset: 0,
            beforeUpdatedAt: null,
            beforeId: null,
        });
        expect(fake.calls[0].args).not.toHaveProperty("p_workspace");
        fake.done();
    });

    it("tabular reviews and their select-all ids", async () => {
        const fake = scriptedDb([
            { rpc: "get_tabular_reviews_overview", data: [] },
            { rpc: "get_tabular_review_ids_overview", data: [] },
        ]);
        await listTabularReviews(fake.db, {
            ...who,
            projectIdFilter: null,
            scope: "all",
            pagination: { limit: 20, offset: 0 },
            searchTerm: null,
            sort: { key: "created", direction: "desc" },
            workspace: "personal",
        });
        await listTabularReviewIds(fake.db, {
            ...who,
            projectIdFilter: null,
            scope: "all",
            searchTerm: null,
            workspace: "personal",
        });
        expect(fake.calls.map((call) => call.args)).toEqual([
            expect.objectContaining({ p_workspace: "personal" }),
            expect.objectContaining({ p_workspace: "personal" }),
        ]);
        fake.done();
    });

    it("workflow filter options and select-all ids", async () => {
        const fake = scriptedDb([
            { rpc: "get_workflow_filter_options", data: [{}] },
            { rpc: "get_workflow_ids_overview", data: [] },
        ]);
        await getWorkflowFilterOptions(fake.db, {
            ...who,
            type: null,
            scope: "all",
            workspace: ORG,
        });
        await listWorkflowIds(fake.db, {
            ...who,
            type: null,
            scope: "all",
            searchTerm: null,
            practice: null,
            language: null,
            jurisdiction: null,
            workspace: ORG,
        });
        expect(fake.calls.map((call) => call.args)).toEqual([
            expect.objectContaining({ p_workspace: ORG }),
            expect.objectContaining({ p_workspace: ORG }),
        ]);
        fake.done();
    });
});

// ---------------------------------------------------------------------------
// Static checks on the SQL, in the manner of orgSqlPredicates.test.ts: the
// list RPCs need a live Postgres to execute, so these assert the shipped shape.
// ---------------------------------------------------------------------------
describe("workspace filter SQL", () => {
    const ROOT = resolve(__dirname, "../../..");
    const SOURCES = {
        "schema.sql": readFileSync(resolve(ROOT, "schema.sql"), "utf8"),
        migration: readFileSync(
            resolve(ROOT, "migrations/20261011_02_workspace_list_filter.sql"),
            "utf8",
        ),
    };
    // Each list RPC, the org_id it must filter on, and how many source arms
    // carry the filter (the workflow RPCs build three and union them).
    const RPCS: [string, string, number][] = [
        ["get_chats_overview", "c.org_id", 1],
        ["get_tabular_reviews_overview", "tr.org_id", 1],
        ["get_tabular_review_ids_overview", "tr.org_id", 1],
        ["get_project_filter_options", "p.org_id", 1],
        ["get_workflow_filter_options", "w.org_id", 3],
        ["get_projects_overview", "p.org_id", 1],
        ["get_project_ids_overview", "p.org_id", 1],
        ["get_project_summaries", "p.org_id", 1],
        ["get_workflows_overview", "w.org_id", 3],
        ["get_workflow_ids_overview", "w.org_id", 3],
    ];

    function definition(sql: string, name: string): string {
        const marker = `create or replace function public.${name}(`;
        const candidates: string[] = [];
        let from = sql.indexOf(marker);
        while (from !== -1) {
            const end = sql.indexOf("\n$$;\n", from);
            candidates.push(sql.slice(from, end));
            from = sql.indexOf(marker, from + 1);
        }
        const scoped = candidates.filter((body) =>
            body.includes("p_workspace text default null"),
        );
        expect(scoped, `${name} should have one workspace-aware definition`)
            .toHaveLength(1);
        return scoped[0];
    }

    describe.each(Object.entries(SOURCES))("%s", (_source, sql) => {
        it.each(RPCS)("%s filters on %s", (name, column, arms) => {
            const body = definition(sql, name);
            const uses = body.split(
                `public.workspace_matches(p_workspace, ${column})`,
            ).length - 1;
            expect(uses).toBe(arms);
        });

        it.each(RPCS)("drops the pre-workspace signature of %s", (name) => {
            // Adding a parameter makes a new function. Left behind, the old
            // one makes the name ambiguous to PostgREST.
            expect(sql).toMatch(
                new RegExp(`drop function if exists public\\.${name}\\(`),
            );
        });

        it("guards the uuid cast behind the null and personal branches", () => {
            const helper = sql.slice(
                sql.indexOf("create or replace function public.workspace_matches("),
            );
            const body = helper.slice(0, helper.indexOf("\n$$;\n"));
            expect(body).toMatch(
                /when p_workspace is null then true\s+when p_workspace = 'personal' then p_org_id is null\s+else p_org_id = p_workspace::uuid/,
            );
        });
    });

    it("defines the helper before the first function that uses it", () => {
        // SQL-language function bodies are checked when they are created.
        for (const sql of Object.values(SOURCES)) {
            const helper = sql.indexOf(
                "create or replace function public.workspace_matches(",
            );
            const firstUse = sql.indexOf("public.workspace_matches(p_workspace,");
            expect(helper).toBeGreaterThan(-1);
            expect(helper).toBeLessThan(firstUse);
        }
    });
});
