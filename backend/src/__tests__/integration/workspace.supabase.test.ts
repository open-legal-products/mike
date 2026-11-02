import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Real SQL coverage: mocks can prove that p_workspace was sent, but cannot
// prove that private/shared rows and inherited project content stay separated.
// Run with backend/scripts/test-stack.sh against the local synthetic stack.
const url = process.env.SUPABASE_TEST_URL;
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const maybeDescribe = url && serviceKey ? describe : describe.skip;
type Item = { id: string; org_id: string | null; visible: boolean; project_id?: string };

maybeDescribe("workspace list isolation", () => {
    let db: SupabaseClient;
    let reader = "";
    let colleague = "";
    const email = `workspace-reader-${randomUUID()}@test.local`;
    const orgs = [randomUUID(), randomUUID()];
    const projects: Item[] = [];
    const chats: Item[] = [];
    const reviews: Item[] = [];
    const scopes = [null, ...orgs];

    beforeAll(async () => {
        db = createClient(url!, serviceKey!, {
            auth: { persistSession: false, autoRefreshToken: false },
        });
        const a = await db.auth.admin.createUser({ email, email_confirm: true });
        if (a.error || !a.data.user) throw a.error ?? new Error("No reader");
        reader = a.data.user.id;
        const b = await db.auth.admin.createUser({
            email: `workspace-colleague-${randomUUID()}@test.local`, email_confirm: true,
        });
        if (b.error || !b.data.user) throw b.error ?? new Error("No colleague");
        colleague = b.data.user.id;
        expect((await db.from("organizations").insert(orgs.map(id => ({
            id, name: "Synthetic workspace", created_by: colleague,
        })))).error).toBeNull();
        expect((await db.from("org_members").insert(orgs.flatMap(org_id => [
            { org_id, user_id: colleague, role: "owner" },
            { org_id, user_id: reader, role: "member" },
        ]))).error).toBeNull();

        for (const org_id of scopes) {
            for (const kind of ["own", "shared", "hidden", ...(org_id ? ["public"] : [])]) {
                const id = randomUUID();
                const visible = kind !== "hidden";
                projects.push({ id, org_id, visible });
                expect((await db.from("projects").insert({
                    id, org_id, user_id: kind === "own" ? reader : colleague,
                    name: `Synthetic ${kind} project`,
                    visibility: kind === "public" ? "organization" : "private",
                })).error).toBeNull();
                if (kind === "shared") {
                    const grant = org_id
                        ? db.from("project_org_access_overrides").insert({
                            project_id: id, org_id, user_id: reader, role: "viewer",
                        })
                        : db.from("project_access_grants").insert({ project_id: id, email, role: "viewer" });
                    expect((await grant).error).toBeNull();
                }
                // Even a chat/review's creator cannot bypass its private
                // project's access rules. Children inherit org_id in SQL.
                for (const [table, items] of [["chats", chats], ["tabular_reviews", reviews]] as const) {
                    const childId = randomUUID();
                    items.push({ id: childId, org_id, visible, project_id: id });
                    const inserted = await db.from(table).insert({
                        id: childId, project_id: id, user_id: reader,
                        title: `Synthetic ${kind} project child`,
                    }).select("org_id").single();
                    expect(inserted.error).toBeNull();
                    expect(inserted.data?.org_id).toBe(org_id);
                }
            }

            for (const [table, grantTable, foreignKey, items] of [
                ["chats", "chat_access_grants", "chat_id", chats],
                ["tabular_reviews", "tabular_review_access_grants", "tabular_review_id", reviews],
            ] as const) {
                for (const kind of ["own", "shared", "hidden"]) {
                    const id = randomUUID();
                    items.push({ id, org_id, visible: kind !== "hidden" });
                    expect((await db.from(table).insert({
                        id, org_id, user_id: kind === "own" ? reader : colleague,
                        title: `Synthetic ${kind} standalone`,
                    })).error).toBeNull();
                    if (kind === "shared") {
                        expect((await db.from(grantTable).insert({
                            [foreignKey]: id, email, role: "viewer",
                        })).error).toBeNull();
                    }
                }
            }
        }
    }, 30_000);

    afterAll(async () => {
        if (!db) return;
        // Remove synthetic content before organizations/members so departure
        // policies do not have to archive it. Never touch pre-existing rows.
        for (const [table, items] of [["chats", chats], ["tabular_reviews", reviews], ["projects", projects]] as const) {
            if (items.length) expect((await db.from(table).delete().in("id", items.map(item => item.id))).error).toBeNull();
        }
        expect((await db.from("organizations").delete().in("id", orgs)).error).toBeNull();
        if (reader) expect((await db.auth.admin.deleteUser(reader)).error).toBeNull();
        if (colleague) expect((await db.auth.admin.deleteUser(colleague)).error).toBeNull();
    });

    const ids = async (rpc: string, args: Record<string, unknown>) => {
        const result = await db.rpc(rpc, { p_user_id: reader, p_user_email: email, ...args });
        expect(result.error, rpc).toBeNull();
        return (result.data as { id: string }[]).map(row => row.id);
    };
    const expected = (items: Item[], orgId: string | null) => items
        .filter(item => item.org_id === orgId && item.visible).map(item => item.id).sort();

    it.each(["member", "admin", "owner"])("keeps private, shared and project items in their workspace for an org %s", async role => {
        expect((await db.from("org_members").update({ role }).eq("user_id", reader).in("org_id", orgs)).error).toBeNull();
        for (const orgId of scopes) {
            const common = { p_workspace: orgId ?? "personal", p_limit: 100, p_offset: 0 };
            const sorted = { p_sort_key: "updated", p_sort_direction: "desc" };
            const projectArgs = {
                ...common, p_scope: "all", p_search_term: null,
                p_practice: null, p_owner_user_id: null,
            };
            expect((await ids("get_projects_overview", { ...projectArgs, ...sorted })).sort())
                .toEqual(expected(projects, orgId));
            expect((await ids("get_project_ids_overview", projectArgs)).sort())
                .toEqual(expected(projects, orgId));
            const reviewArgs = {
                ...common, p_project_id: null, p_scope: "all", p_search_term: null,
            };
            expect((await ids("get_tabular_reviews_overview", { ...reviewArgs, ...sorted })).sort())
                .toEqual(expected(reviews, orgId));
            expect((await ids("get_tabular_review_ids_overview", reviewArgs)).sort())
                .toEqual(expected(reviews, orgId));
            expect((await ids("get_chats_overview", common)).sort()).toEqual(expected(chats, orgId));

            // Exercise paginated History/overview queries, not only a large
            // first page. Filtering must happen before LIMIT/OFFSET.
            for (const [rpc, args, items] of [
                ["get_projects_overview", { ...projectArgs, ...sorted }, projects],
                ["get_tabular_reviews_overview", { ...reviewArgs, ...sorted }, reviews],
                ["get_chats_overview", common, chats],
            ] as const) {
                const paged: string[] = [];
                for (let offset = 0; offset < 20; offset += 2) {
                    const page = await ids(rpc, { ...args, p_limit: 2, p_offset: offset });
                    paged.push(...page);
                    if (page.length < 2) break;
                }
                expect(paged.sort()).toEqual(expected(items, orgId));
            }

            // A project filter cannot escape the overview's workspace.
            const otherProject = projects.find(item => item.visible && item.org_id !== orgId)!;
            expect(await ids("get_tabular_reviews_overview", {
                ...reviewArgs, ...sorted, p_project_id: otherProject.id,
            })).toEqual([]);
        }
    }, 30_000);
});
