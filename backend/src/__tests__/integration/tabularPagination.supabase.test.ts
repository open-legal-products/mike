import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.SUPABASE_TEST_URL;
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const maybeDescribe = url && serviceKey ? describe : describe.skip;

/* supabase-js types an rpc() result's `data` as `any`, so the `.map()` /
   `.every()` callbacks below get no inferred parameter type (and, under
   noImplicitAny, no type check at all). Name the handful of overview columns
   these assertions actually read. */
type OverviewRow = {
    id: string;
    project_id: string | null;
    columns_config: unknown[] | null;
};

maybeDescribe("Supabase tabular-review pagination", () => {
    let ownerId = "";
    let ownerEmail = "";
    const projectId = crypto.randomUUID();
    const projectReviewIds = Array.from({ length: 25 }, () =>
        crypto.randomUUID(),
    );
    const standaloneReviewIds = Array.from({ length: 5 }, () =>
        crypto.randomUUID(),
    );
    const tiedCreatedAt = "2026-07-27T00:00:00.000Z";
    let admin: SupabaseClient;

    beforeAll(async () => {
        admin = createClient(url!, serviceKey!, {
            auth: { persistSession: false, autoRefreshToken: false },
        });

        ownerEmail = `pagination-${Date.now()}@test.local`;
        const owner = await admin.auth.admin.createUser({
            email: ownerEmail,
            password: "StackTest1!",
            email_confirm: true,
        });
        if (owner.error || !owner.data.user) {
            throw owner.error ?? new Error("Could not create pagination owner");
        }
        ownerId = owner.data.user.id;

        const project = await admin.from("projects").insert({
            id: projectId,
            user_id: ownerId,
            name: "Pagination integration project",
        });
        if (project.error) throw project.error;

        const projectReviews = await admin.from("tabular_reviews").insert(
            projectReviewIds.map((id, index) => ({
                id,
                project_id: projectId,
                user_id: ownerId,
                title: "Needle Review",
                columns_config: Array.from(
                    { length: index % 5 },
                    (_, columnIndex) => ({
                        index: columnIndex,
                        name: `Column ${columnIndex}`,
                        prompt: `Prompt ${columnIndex}`,
                    }),
                ),
                document_ids: [],
                created_at: tiedCreatedAt,
                updated_at: tiedCreatedAt,
            })),
        );
        if (projectReviews.error) throw projectReviews.error;

        const standaloneReviews = await admin.from("tabular_reviews").insert(
            standaloneReviewIds.map((id) => ({
                id,
                user_id: ownerId,
                title: "Standalone Needle",
                columns_config: [],
                document_ids: [],
                created_at: tiedCreatedAt,
                updated_at: tiedCreatedAt,
            })),
        );
        if (standaloneReviews.error) throw standaloneReviews.error;
    });

    afterAll(async () => {
        if (!admin) return;
        await admin
            .from("tabular_reviews")
            .delete()
            .in("id", standaloneReviewIds);
        await admin.from("projects").delete().eq("id", projectId);
        if (ownerId) await admin.auth.admin.deleteUser(ownerId);
    });

    it("paginates tied rows deterministically without duplicates", async () => {
        const commonArgs = {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_project_id: projectId,
            p_scope: "in-project",
            p_search_term: "needle",
            p_sort_key: "name",
            p_sort_direction: "asc",
        };
        const firstPage = await admin.rpc("get_tabular_reviews_overview", {
            ...commonArgs,
            p_limit: 20,
            p_offset: 0,
        });
        const secondPage = await admin.rpc("get_tabular_reviews_overview", {
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
        expect([...firstIds, ...secondIds]).toEqual(
            [...projectReviewIds].sort(),
        );
    });

    it("filters by scope alone (no project_id) across every accessible project", async () => {
        // This is the request the "In Project" / "Standalone" tabs on the
        // global tabular-reviews list send: a scope with no project_id, so
        // it must filter across every project the user can see rather than
        // just the one seeded project.
        const inProject = await admin.rpc("get_tabular_reviews_overview", {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_project_id: null,
            p_scope: "in-project",
            p_limit: 100,
            p_offset: 0,
            p_search_term: "needle",
            p_sort_key: "created",
            p_sort_direction: "desc",
        });
        const standalone = await admin.rpc("get_tabular_reviews_overview", {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_project_id: null,
            p_scope: "standalone",
            p_limit: 100,
            p_offset: 0,
            p_search_term: "needle",
            p_sort_key: "created",
            p_sort_direction: "desc",
        });

        expect(inProject.error).toBeNull();
        expect(standalone.error).toBeNull();

        const inProjectIds = new Set(
            (inProject.data ?? []).map((row: OverviewRow) => row.id as string),
        );
        const standaloneIds = new Set(
            (standalone.data ?? []).map((row: OverviewRow) => row.id as string),
        );

        for (const id of projectReviewIds) expect(inProjectIds.has(id)).toBe(true);
        for (const id of standaloneReviewIds)
            expect(inProjectIds.has(id)).toBe(false);

        for (const id of standaloneReviewIds)
            expect(standaloneIds.has(id)).toBe(true);
        for (const id of projectReviewIds)
            expect(standaloneIds.has(id)).toBe(false);

        expect(
            (inProject.data ?? []).every((row: OverviewRow) => row.project_id !== null),
        ).toBe(true);
        expect(
            (standalone.data ?? []).every((row: OverviewRow) => row.project_id === null),
        ).toBe(true);
    });

    it("applies scope and search before limiting rows", async () => {
        const result = await admin.rpc("get_tabular_reviews_overview", {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_project_id: null,
            p_scope: "standalone",
            p_limit: 100,
            p_offset: 0,
            p_search_term: "standalone needle",
            p_sort_key: "created",
            p_sort_direction: "desc",
        });

        expect(result.error).toBeNull();
        expect(result.data).toHaveLength(5);
        expect(
            (result.data ?? []).every((row: OverviewRow) => row.project_id === null),
        ).toBe(true);
    });

    it.each(["%", "_"])(
        "treats %s as a literal search character",
        async (searchTerm) => {
            const reviews = await admin.rpc("get_tabular_reviews_overview", {
                p_user_id: ownerId,
                p_user_email: ownerEmail,
                p_project_id: null,
                p_scope: "all",
                p_limit: 100,
                p_offset: 0,
                p_search_term: searchTerm,
                p_sort_key: "created",
                p_sort_direction: "desc",
            });
            const ids = await admin.rpc("get_tabular_review_ids_overview", {
                p_user_id: ownerId,
                p_user_email: ownerEmail,
                p_project_id: null,
                p_scope: "all",
                p_search_term: searchTerm,
                p_limit: 100,
                p_offset: 0,
            });

            expect(reviews.error).toBeNull();
            expect(ids.error).toBeNull();
            expect(reviews.data).toEqual([]);
            expect(ids.data).toEqual([]);
        },
    );

    it("sorts the complete filtered set before pagination", async () => {
        const result = await admin.rpc("get_tabular_reviews_overview", {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_project_id: projectId,
            p_scope: "in-project",
            p_limit: 25,
            p_offset: 0,
            p_search_term: null,
            p_sort_key: "columns",
            p_sort_direction: "asc",
        });

        expect(result.error).toBeNull();
        const columnCounts = (result.data ?? []).map(
            (row: OverviewRow) =>
                (row.columns_config as unknown[] | null | undefined)?.length ??
                0,
        );
        expect(columnCounts).toEqual([...columnCounts].sort((a, b) => a - b));
    });

    it("returns ids + owner for every matching review within one page", async () => {
        // Backs the "select all matching" bulk action: needs only id +
        // user_id, not the full review payload, for the entire filtered set.
        const result = await admin.rpc("get_tabular_review_ids_overview", {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_project_id: null,
            p_scope: "in-project",
            p_search_term: "needle",
            p_limit: 1000,
            p_offset: 0,
        });

        expect(result.error).toBeNull();
        const rows = (result.data ?? []) as { id: string; user_id: string }[];
        expect(rows).toHaveLength(projectReviewIds.length);
        expect(new Set(rows.map((row) => row.id))).toEqual(
            new Set(projectReviewIds),
        );
        expect(rows.every((row) => row.user_id === ownerId)).toBe(true);
    });

    it("paginates the ids RPC deterministically without duplicates or gaps", async () => {
        // Proves the pagination contract the /tabular-review/ids route relies
        // on to page past PostgREST's own row cap: consecutive small pages
        // must together cover the full filtered set with no overlap.
        const pageSize = 10;
        const collected: string[] = [];
        for (let offset = 0; offset < projectReviewIds.length; offset += pageSize) {
            const page = await admin.rpc("get_tabular_review_ids_overview", {
                p_user_id: ownerId,
                p_user_email: ownerEmail,
                p_project_id: null,
                p_scope: "in-project",
                p_search_term: "needle",
                p_limit: pageSize,
                p_offset: offset,
            });
            expect(page.error).toBeNull();
            collected.push(...(page.data ?? []).map((row: OverviewRow) => row.id as string));
        }

        expect(new Set(collected).size).toBe(projectReviewIds.length);
        expect([...collected].sort()).toEqual([...projectReviewIds].sort());
    });

    it("keeps the legacy three-argument RPC callable", async () => {
        const result = await admin.rpc("get_tabular_reviews_overview", {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_project_id: null,
        });

        expect(result.error).toBeNull();
        const returnedIds = new Set(
            (result.data ?? []).map((row: OverviewRow) => row.id as string),
        );
        for (const id of [...projectReviewIds, ...standaloneReviewIds])
            expect(returnedIds.has(id)).toBe(true);
    });
});
