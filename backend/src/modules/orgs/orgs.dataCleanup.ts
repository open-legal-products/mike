// Bulk deletion of what an organization owns.
//
// Behind the facade, used when an owner clears content from the
// organization's Privacy & data page. Organization deletion itself retains
// content during its recovery period; the lifecycle SQL sweep owns expiry.
//
// Callers authorize first (owner only). Nothing here checks a role, and every
// function throws on a failed read or write so a partial purge is never
// reported as a finished one.

import {
    captureInlineDocumentCleanup,
    completeInlineDocumentCleanup,
} from "../documents/documents.service";
import { deleteProjectsByIds } from "../user/user.service";
import { chunkArray } from "../../lib/arrays";
import type { Db } from "../../lib/supabase";

/** `in(...)` travels in the request URL; 50 uuids stay under the gateway's limit. */
const BATCH_SIZE = 50;

/**
 * Upper bound on select-then-delete rounds. A round that deletes nothing
 * ends the loop on its own; this only stops a store that keeps answering
 * with the same rows from spinning forever.
 */
const MAX_ROUNDS = 10_000;

type OrgContentTable =
    | "projects"
    | "documents"
    | "chats"
    | "tabular_reviews"
    | "workflows";

function fail(message: string): never {
    throw new Error(message);
}

/**
 * One page of the ids this organization owns in `table`. Read a page at a
 * time, and again after each delete, so the API's row cap cannot leave a
 * tail behind and rows created mid-purge are still picked up.
 */
async function nextOrgIds(
    db: Db,
    table: OrgContentTable,
    orgId: string,
): Promise<string[]> {
    const { data, error } = await db
        .from(table)
        .select("id")
        .eq("org_id", orgId)
        .limit(BATCH_SIZE);
    if (error) fail(`Failed to load organization ${table}`);
    return ((data ?? []) as { id?: unknown }[])
        .map((row) => row.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
}

async function purgeOrgTable(
    db: Db,
    table: OrgContentTable,
    orgId: string,
    deleteBatch: (ids: string[]) => Promise<void>,
): Promise<number> {
    let deleted = 0;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const ids = await nextOrgIds(db, table, orgId);
        if (ids.length === 0) return deleted;
        await deleteBatch(ids);
        deleted += ids.length;
    }
    return fail(`Failed to finish deleting organization ${table}`);
}

/** Every project the organization owns, with its documents, chats and reviews. */
export async function deleteOrgProjects(db: Db, orgId: string): Promise<number> {
    return purgeOrgTable(db, "projects", orgId, async (ids) => {
        await deleteProjectsByIds(db, ids);
    });
}

/** Every workflow the organization owns, with its attached documents. */
export async function deleteOrgWorkflows(db: Db, orgId: string): Promise<number> {
    return purgeOrgTable(db, "workflows", orgId, async (ids) => {
        for (const workflowId of ids) {
            const keys = await captureInlineDocumentCleanup(db, { workflowId });
            const { error } = await db
                .from("workflows")
                .delete()
                .eq("id", workflowId)
                .eq("org_id", orgId);
            if (error) fail("Failed to delete organization workflows");
            await completeInlineDocumentCleanup(db, keys);
        }
    });
}

/** Organization documents that sit outside any project or workflow. */
export async function deleteOrgDocuments(db: Db, orgId: string): Promise<number> {
    return purgeOrgTable(db, "documents", orgId, async (ids) => {
        const keys = await captureInlineDocumentCleanup(db, { documentIds: ids });
        const { error } = await db
            .from("documents")
            .delete()
            .eq("org_id", orgId)
            .in("id", ids);
        if (error) fail("Failed to delete organization documents");
        await completeInlineDocumentCleanup(db, keys);
    });
}

/** Every tabular review the organization owns, with its cells and chats. */
export async function deleteOrgTabularReviews(
    db: Db,
    orgId: string,
): Promise<number> {
    return purgeOrgTable(db, "tabular_reviews", orgId, async (ids) => {
        // The parent delete is atomic; its cascades fence each child chat.
        const { error } = await db
            .from("tabular_reviews")
            .delete()
            .eq("org_id", orgId)
            .in("id", ids);
        if (error) fail("Failed to delete organization tabular reviews");
    });
}

/**
 * Every id the organization owns in `table`, without deleting anything.
 * Used where the rows stay and only something attached to them goes.
 */
async function allOrgIds(
    db: Db,
    table: OrgContentTable,
    orgId: string,
): Promise<string[]> {
    const ids: string[] = [];
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const { data, error } = await db
            .from(table)
            .select("id")
            .eq("org_id", orgId)
            .order("id", { ascending: true })
            .range(ids.length, ids.length + 999);
        if (error) fail(`Failed to load organization ${table}`);
        const page = ((data ?? []) as { id?: unknown }[])
            .map((row) => row.id)
            .filter((id): id is string => typeof id === "string" && id.length > 0);
        ids.push(...page);
        if (page.length < 1000) return ids;
    }
    return fail(`Failed to load organization ${table}`);
}

/**
 * The organization's chat history: assistant chats it owns, chats inside its
 * projects, and the chats attached to its tabular reviews. The projects and
 * reviews themselves stay.
 */
export async function deleteOrgChats(db: Db, orgId: string): Promise<void> {
    await purgeOrgTable(db, "chats", orgId, async (ids) => {
        const { error } = await db
            .from("chats")
            .delete()
            .eq("org_id", orgId)
            .in("id", ids);
        if (error) fail("Failed to delete organization chats");
    });

    const projectIds = await allOrgIds(db, "projects", orgId);
    for (const batch of chunkArray(projectIds, BATCH_SIZE)) {
        const { error } = await db.from("chats").delete().in("project_id", batch);
        if (error) fail("Failed to delete organization project chats");
    }

    const reviewIds = await allOrgIds(db, "tabular_reviews", orgId);
    for (const batch of chunkArray(reviewIds, BATCH_SIZE)) {
        const { error } = await db
            .from("tabular_review_chats")
            .delete()
            .in("review_id", batch);
        if (error) fail("Failed to delete organization tabular review chats");
    }
}

/**
 * Empty the organization's memory: every project it owns, and each member's
 * own memory for this organization. The files stay,
 * and stay enabled, so memory rebuilds from later conversations; the database
 * function empties each body under its row lock so an in-flight curator job
 * cannot write the old content back.
 */
export async function deleteOrgMemories(db: Db, orgId: string): Promise<void> {
    // Each member's own memory for this organization. It is private to them
    // and nobody here reads it; clearing the organization's memory clears
    // these too, so that nothing learned in it is left anywhere.
    const { data: memberFiles, error: memberError } = await db
        .from("memory_files")
        .select("id")
        .eq("scope", "user")
        .eq("org_id", orgId);
    // 42703: a database from before memory was per workspace has none.
    if (memberError && memberError.code !== "42703" && memberError.code !== "PGRST204")
        fail("Failed to load organization memory");
    for (const row of (memberFiles ?? []) as { id?: unknown }[]) {
        if (typeof row.id !== "string" || !row.id) continue;
        const result = await db.rpc("wipe_memory_file", {
            p_memory_file_id: row.id,
            p_enabled: null,
            p_updated_by: null,
            p_source: "wipe",
        });
        if (result.error) fail("Failed to delete organization memory");
    }

    const projectIds = await allOrgIds(db, "projects", orgId);
    for (const batch of chunkArray(projectIds, BATCH_SIZE)) {
        const { data, error } = await db
            .from("memory_files")
            .select("id")
            .eq("scope", "project")
            .in("project_id", batch);
        if (error) fail("Failed to load organization memory");
        for (const row of (data ?? []) as { id?: unknown }[]) {
            if (typeof row.id !== "string" || !row.id) continue;
            const result = await db.rpc("wipe_memory_file", {
                p_memory_file_id: row.id,
                // null keeps whatever "enabled" resolves to under the lock.
                p_enabled: null,
                p_updated_by: null,
                p_source: "wipe",
            });
            if (result.error) fail("Failed to delete organization memory");
        }
    }
}

/**
 * Everything the organization owns. Projects go first because their cascade
 * takes most documents, chats and reviews with them; what is left is content
 * tagged to the organization outside any project.
 */
export async function deleteOrgContent(db: Db, orgId: string): Promise<void> {
    await deleteOrgProjects(db, orgId);
    await deleteOrgWorkflows(db, orgId);
    await deleteOrgDocuments(db, orgId);
    await deleteOrgTabularReviews(db, orgId);
    await deleteOrgChats(db, orgId);
}
