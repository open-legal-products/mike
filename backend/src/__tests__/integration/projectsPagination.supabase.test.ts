import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The RPCs return `any`; naming the row shape is what lets tsc check the
// property reads below instead of silently widening them.
type ProjectRow = {
    id: string;
    org_id: string | null;
    access_scope: string;
    organization_name: string | null;
};

const url = process.env.SUPABASE_TEST_URL;
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const maybeDescribe = url && serviceKey ? describe : describe.skip;

/* supabase-js types an rpc() result's `data` as `any`, so the `.map()` /
   `.every()` callbacks below get no inferred parameter type (and, under
   noImplicitAny, no type check at all). Name the handful of overview columns
   these assertions actually read. */
type OverviewRow = {
    id: string;
    name: string;
    is_owner: boolean;
};

maybeDescribe("Supabase projects-overview pagination", () => {
    let ownerId = "";
    let ownerEmail = "";
    let otherUserId = "";
    const orgId = crypto.randomUUID();
    const orgProjectId = crypto.randomUUID();
    const ownedSharedProjectId = crypto.randomUUID();
    const myProjectIds = Array.from({ length: 25 }, () => crypto.randomUUID());
    const sharedProjectIds = Array.from({ length: 5 }, () => crypto.randomUUID());
    const tiedCreatedAt = "2026-07-27T00:00:00.000Z";
    let admin: SupabaseClient;

    beforeAll(async () => {
        admin = createClient(url!, serviceKey!, {
            auth: { persistSession: false, autoRefreshToken: false },
        });

        const suffix = Date.now();
        ownerEmail = `pagination-owner-${suffix}@test.local`;
        const otherUserEmail = `pagination-other-${suffix}@test.local`;
        const owner = await admin.auth.admin.createUser({
            email: ownerEmail,
            password: "StackTest1!",
            email_confirm: true,
        });
        if (owner.error || !owner.data.user) {
            throw owner.error ?? new Error("Could not create pagination owner");
        }
        ownerId = owner.data.user.id;

        const otherUser = await admin.auth.admin.createUser({
            email: otherUserEmail,
            password: "StackTest1!",
            email_confirm: true,
        });
        if (otherUser.error || !otherUser.data.user) {
            throw (
                otherUser.error ??
                new Error("Could not create shared-project owner")
            );
        }
        otherUserId = otherUser.data.user.id;

        const organization = await admin.from("organizations").insert({
            id: orgId,
            name: "Pagination Test Firm",
            created_by: ownerId,
        });
        if (organization.error) throw organization.error;
        const membership = await admin.from("org_members").insert({
            org_id: orgId,
            user_id: ownerId,
            role: "admin",
        });
        if (membership.error) throw membership.error;

        const myProjects = await admin.from("projects").insert(
            myProjectIds.map((id) => ({
                id,
                user_id: ownerId,
                name: "Needle Project",
                practice: "Litigation",
                created_at: tiedCreatedAt,
                updated_at: tiedCreatedAt,
            })),
        );
        if (myProjects.error) throw myProjects.error;

        const ownedSharedProject = await admin.from("projects").insert({
            id: ownedSharedProjectId,
            user_id: ownerId,
            name: "Owned Collaborative Project",
            practice: "Litigation",
            created_at: tiedCreatedAt,
            updated_at: tiedCreatedAt,
        });
        if (ownedSharedProject.error) throw ownedSharedProject.error;

        const sharedProjects = await admin.from("projects").insert(
            sharedProjectIds.map((id) => ({
                id,
                user_id: otherUserId,
                name: "Shared Needle",
                practice: "Corporate",
                created_at: tiedCreatedAt,
                updated_at: tiedCreatedAt,
            })),
        );
        if (sharedProjects.error) throw sharedProjects.error;

        const orgProject = await admin.from("projects").insert({
            id: orgProjectId,
            user_id: ownerId,
            org_id: orgId,
            name: "Firm Matter",
            practice: "Litigation",
            created_at: tiedCreatedAt,
            updated_at: tiedCreatedAt,
        });
        if (orgProject.error) throw orgProject.error;

        const grants = await admin.from("project_access_grants").insert([
            {
                project_id: ownedSharedProjectId,
                email: otherUserEmail,
                role: "editor",
                created_by: ownerId,
            },
            ...sharedProjectIds.map((projectId) => ({
                project_id: projectId,
                email: ownerEmail,
                role: "editor",
                created_by: otherUserId,
            })),
        ]);
        if (grants.error) throw grants.error;
    });

    afterAll(async () => {
        if (!admin) return;
        await admin.from("projects").delete().in("id", myProjectIds);
        await admin.from("projects").delete().in("id", sharedProjectIds);
        await admin.from("projects").delete().eq("id", ownedSharedProjectId);
        await admin.from("projects").delete().eq("id", orgProjectId);
        await admin.from("organizations").delete().eq("id", orgId);
        if (otherUserId) await admin.auth.admin.deleteUser(otherUserId);
        if (ownerId) await admin.auth.admin.deleteUser(ownerId);
    });

    it("paginates tied rows deterministically without duplicates", async () => {
        const commonArgs = {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_scope: "mine",
            p_search_term: "needle",
            p_sort_key: "name",
            p_sort_direction: "asc",
            p_practice: null,
            p_owner_user_id: null,
        };
        const firstPage = await admin.rpc("get_projects_overview", {
            ...commonArgs,
            p_limit: 20,
            p_offset: 0,
        });
        const secondPage = await admin.rpc("get_projects_overview", {
            ...commonArgs,
            p_limit: 20,
            p_offset: 20,
        });

        expect(firstPage.error).toBeNull();
        expect(secondPage.error).toBeNull();
        expect(firstPage.data).toHaveLength(20);
        expect(secondPage.data).toHaveLength(5);

        const firstIds = (firstPage.data ?? []).map((row: OverviewRow) => row.id);
        const secondIds = (secondPage.data ?? []).map((row: OverviewRow) => row.id);
        expect(new Set([...firstIds, ...secondIds]).size).toBe(25);
        expect([...firstIds, ...secondIds]).toEqual([...myProjectIds].sort());
    });

    it("filters by scope: mine vs shared", async () => {
        const mine = await admin.rpc("get_projects_overview", {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_scope: "mine",
            p_limit: 100,
            p_offset: 0,
            p_search_term: "needle",
            p_sort_key: "created",
            p_sort_direction: "desc",
            p_practice: null,
            p_owner_user_id: null,
        });
        const shared = await admin.rpc("get_projects_overview", {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_scope: "shared",
            p_limit: 100,
            p_offset: 0,
            p_search_term: "needle",
            p_sort_key: "created",
            p_sort_direction: "desc",
            p_practice: null,
            p_owner_user_id: null,
        });

        expect(mine.error).toBeNull();
        expect(shared.error).toBeNull();

        const mineIds = new Set((mine.data ?? []).map((row: OverviewRow) => row.id as string));
        const sharedIds = new Set(
            (shared.data ?? []).map((row: OverviewRow) => row.id as string),
        );

        for (const id of myProjectIds) expect(mineIds.has(id)).toBe(true);
        for (const id of sharedProjectIds) expect(mineIds.has(id)).toBe(false);

        for (const id of sharedProjectIds) expect(sharedIds.has(id)).toBe(true);
        for (const id of myProjectIds) expect(sharedIds.has(id)).toBe(false);

        expect((mine.data ?? []).every((row: OverviewRow) => row.is_owner === true)).toBe(
            true,
        );
        expect(
            (shared.data ?? []).every((row: OverviewRow) => row.is_owner === false),
        ).toBe(true);
    });

    it("separates collaborative projects from projects with no other users", async () => {
        const collaborative = await admin.rpc("get_projects_overview", {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_scope: "collaborative",
            p_limit: 100,
            p_offset: 0,
            p_search_term: null,
            p_sort_key: "created",
            p_sort_direction: "desc",
            p_practice: null,
            p_owner_user_id: null,
        });
        const privateProjects = await admin.rpc("get_projects_overview", {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_scope: "private",
            p_limit: 100,
            p_offset: 0,
            p_search_term: null,
            p_sort_key: "created",
            p_sort_direction: "desc",
            p_practice: null,
            p_owner_user_id: null,
        });
        const collaborativeIdRows = await admin.rpc(
            "get_project_ids_overview",
            {
                p_user_id: ownerId,
                p_user_email: ownerEmail,
                p_scope: "collaborative",
                p_search_term: null,
                p_practice: null,
                p_owner_user_id: null,
                p_limit: 100,
                p_offset: 0,
            },
        );
        const privateIdRows = await admin.rpc("get_project_ids_overview", {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_scope: "private",
            p_search_term: null,
            p_practice: null,
            p_owner_user_id: null,
            p_limit: 100,
            p_offset: 0,
        });

        expect(collaborative.error).toBeNull();
        expect(privateProjects.error).toBeNull();
        expect(collaborativeIdRows.error).toBeNull();
        expect(privateIdRows.error).toBeNull();

        const collaborativeIds = new Set(
            (collaborative.data ?? []).map((row: ProjectRow) => row.id as string),
        );
        const privateIds = new Set(
            (privateProjects.data ?? []).map((row: ProjectRow) => row.id as string),
        );

        expect(collaborativeIds).toEqual(
            new Set([...sharedProjectIds, ownedSharedProjectId, orgProjectId]),
        );
        expect(privateIds).toEqual(new Set(myProjectIds));
        expect(
            (collaborative.data ?? []).find(
                (row: ProjectRow) => row.id === ownedSharedProjectId,
            ),
        ).toMatchObject({
            org_id: null,
            access_scope: "shared",
            organization_name: null,
        });
        expect(
            (privateProjects.data ?? []).find(
                (row: ProjectRow) => row.id === myProjectIds[0],
            ),
        ).toMatchObject({
            org_id: null,
            access_scope: "private",
            organization_name: null,
        });
        expect(
            (collaborative.data ?? []).find(
                (row: ProjectRow) => row.id === orgProjectId,
            ),
        ).toMatchObject({
            org_id: orgId,
            access_scope: "organization",
            organization_name: "Pagination Test Firm",
        });
        expect(
            new Set(
                (collaborativeIdRows.data ?? []).map(
                    (row: ProjectRow) => row.id as string,
                ),
            ),
        ).toEqual(collaborativeIds);
        expect(
            new Set(
                (privateIdRows.data ?? []).map((row: ProjectRow) => row.id as string),
            ),
        ).toEqual(privateIds);
    });

    it("filters by exact practice and owner match", async () => {
        const byPractice = await admin.rpc("get_projects_overview", {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_scope: "all",
            p_limit: 100,
            p_offset: 0,
            p_search_term: "needle",
            p_sort_key: "created",
            p_sort_direction: "desc",
            p_practice: "Corporate",
            p_owner_user_id: null,
        });
        const byOwner = await admin.rpc("get_projects_overview", {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_scope: "all",
            p_limit: 100,
            p_offset: 0,
            p_search_term: "needle",
            p_sort_key: "created",
            p_sort_direction: "desc",
            p_practice: null,
            p_owner_user_id: otherUserId,
        });

        expect(byPractice.error).toBeNull();
        expect(byOwner.error).toBeNull();
        expect(
            new Set((byPractice.data ?? []).map((row: OverviewRow) => row.id as string)),
        ).toEqual(new Set(sharedProjectIds));
        expect(
            new Set((byOwner.data ?? []).map((row: OverviewRow) => row.id as string)),
        ).toEqual(new Set(sharedProjectIds));
    });

    it.each(["%", "_"])(
        "treats %s as a literal search character",
        async (searchTerm) => {
            const projects = await admin.rpc("get_projects_overview", {
                p_user_id: ownerId,
                p_user_email: ownerEmail,
                p_scope: "all",
                p_limit: 100,
                p_offset: 0,
                p_search_term: searchTerm,
                p_sort_key: "created",
                p_sort_direction: "desc",
                p_practice: null,
                p_owner_user_id: null,
            });
            const ids = await admin.rpc("get_project_ids_overview", {
                p_user_id: ownerId,
                p_user_email: ownerEmail,
                p_scope: "all",
                p_search_term: searchTerm,
                p_practice: null,
                p_owner_user_id: null,
                p_limit: 100,
                p_offset: 0,
            });

            expect(projects.error).toBeNull();
            expect(ids.error).toBeNull();
            expect(projects.data).toEqual([]);
            expect(ids.data).toEqual([]);
        },
    );

    it("sorts the complete filtered set before pagination", async () => {
        const result = await admin.rpc("get_projects_overview", {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_scope: "mine",
            p_limit: 25,
            p_offset: 0,
            p_search_term: null,
            p_sort_key: "name",
            p_sort_direction: "asc",
            p_practice: null,
            p_owner_user_id: null,
        });

        expect(result.error).toBeNull();
        const names = (result.data ?? []).map((row: OverviewRow) => row.name as string);
        expect(names).toEqual([...names].sort());
    });

    it("returns ids + owner for every matching project within one page", async () => {
        // Backs the "select all matching" bulk action: needs only id +
        // user_id, not the full project payload, for the entire filtered set.
        const result = await admin.rpc("get_project_ids_overview", {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_scope: "mine",
            p_search_term: "needle",
            p_practice: null,
            p_owner_user_id: null,
            p_limit: 1000,
            p_offset: 0,
        });

        expect(result.error).toBeNull();
        const rows = (result.data ?? []) as { id: string; user_id: string }[];
        expect(rows).toHaveLength(myProjectIds.length);
        expect(new Set(rows.map((row) => row.id))).toEqual(
            new Set(myProjectIds),
        );
        expect(rows.every((row) => row.user_id === ownerId)).toBe(true);
    });

    it("paginates the ids RPC deterministically without duplicates or gaps", async () => {
        // Proves the pagination contract the /projects/ids route relies on
        // to page past PostgREST's own row cap: consecutive small pages must
        // together cover the full filtered set with no overlap.
        const pageSize = 10;
        const collected: string[] = [];
        for (let offset = 0; offset < myProjectIds.length; offset += pageSize) {
            const page = await admin.rpc("get_project_ids_overview", {
                p_user_id: ownerId,
                p_user_email: ownerEmail,
                p_scope: "mine",
                p_search_term: "needle",
                p_practice: null,
                p_owner_user_id: null,
                p_limit: pageSize,
                p_offset: offset,
            });
            expect(page.error).toBeNull();
            collected.push(...(page.data ?? []).map((row: OverviewRow) => row.id as string));
        }

        expect(new Set(collected).size).toBe(myProjectIds.length);
        expect([...collected].sort()).toEqual([...myProjectIds].sort());
    });

    it("keeps the legacy two-argument RPC callable", async () => {
        const result = await admin.rpc("get_projects_overview", {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
        });

        expect(result.error).toBeNull();
        const returnedIds = new Set(
            (result.data ?? []).map((row: OverviewRow) => row.id as string),
        );
        for (const id of [...myProjectIds, ...sharedProjectIds])
            expect(returnedIds.has(id)).toBe(true);
    });
});
