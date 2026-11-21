import type {
    OrgDeparture, OrgDepartureArchive, OrgDepartureArchivePage, OrgDepartureList, OrgDepartureResolution,
} from "@mike/contracts";
import { AppError } from "../../lib/appError";
import { getOrgRole } from "../../lib/access";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import type { Db } from "../../lib/supabase";
import { captureInlineDocumentCleanup, completeInlineDocumentCleanup } from "../documents/documents.service";

interface ArchiveActor { orgId: string; userId: string }

async function requireOwner(db: Db, actor: ArchiveActor) {
    const role = await getOrgRole(actor.userId, actor.orgId, db);
    if (!role) return failure("not_found", "Organization not found.");
    if (role !== "owner") return failure("forbidden", "Only organization owners can manage archived work.");
    return null;
}

export async function listDepartureArchives(
    db: Db,
    actor: ArchiveActor & { limit: number; offset: number },
): Promise<ServiceResult<OrgDepartureArchivePage>> {
    const denied = await requireOwner(db, actor);
    if (denied) return denied;
    const { data, error } = await db.rpc("list_org_departure_archives", {
        p_org_id: actor.orgId, p_actor_id: actor.userId,
        p_limit: actor.limit + 1, p_offset: actor.offset,
    });
    if (error) return internalFailure(error);
    const rows = (data ?? []) as OrgDepartureArchive[];
    return ok({ items: rows.slice(0, actor.limit), nextOffset: rows.length > actor.limit ? actor.offset + actor.limit : null });
}

/** The most archived items one listing returns, and one bulk action takes. */
const DEPARTURE_ITEM_LIMIT = 2000;
const BULK_ARCHIVE_LIMIT = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DepartureWorkRow extends OrgDepartureArchive {
    former_user_id: string | null; former_display_name: string | null; former_email: string | null;
    documents: number | null; chats: number | null; tabular_reviews: number | null;
}

/** Unexpired archived work grouped by the departure that left it, soonest deletion first. */
export async function listDepartures(db: Db, actor: ArchiveActor): Promise<ServiceResult<OrgDepartureList>> {
    const denied = await requireOwner(db, actor);
    if (denied) return denied;
    const { data, error } = await db.rpc("list_org_departure_work", {
        p_org_id: actor.orgId, p_actor_id: actor.userId, p_limit: DEPARTURE_ITEM_LIMIT + 1,
    });
    if (error) return internalFailure(error);
    const rows = (data ?? []) as DepartureWorkRow[];
    const departures = new Map<string, OrgDeparture>();
    for (const row of rows.slice(0, DEPARTURE_ITEM_LIMIT)) {
        // A departure archives everything in one transaction, so its rows
        // share a timestamp. Rows arrive soonest deletion first, so a
        // departure's first row carries its earliest expiry.
        const key = `${row.former_user_id ?? "deleted"}:${row.archived_at}`;
        let departure = departures.get(key);
        if (!departure) {
            departure = {
                key, departed_at: row.archived_at, expires_at: row.expires_at, items: [],
                member: row.former_user_id
                    ? { user_id: row.former_user_id, display_name: row.former_display_name, email: row.former_email }
                    : null,
            };
            departures.set(key, departure);
        }
        departure.items.push({
            id: row.id, kind: row.kind, item_id: row.item_id, title: row.title,
            archived_at: row.archived_at, expires_at: row.expires_at,
            ...(row.kind === "project" || row.kind === "workflow"
                ? { contents: { documents: row.documents ?? 0, chats: row.chats ?? 0, tabular_reviews: row.tabular_reviews ?? 0 } }
                : {}),
        });
    }
    return ok({ departures: [...departures.values()], truncated: rows.length > DEPARTURE_ITEM_LIMIT });
}

async function cleanupKeys(db: Db, item: Pick<OrgDepartureArchive, "kind" | "item_id">) {
    if (item.kind === "project") return captureInlineDocumentCleanup(db, { projectIds: [item.item_id] });
    if (item.kind === "workflow") return captureInlineDocumentCleanup(db, { workflowId: item.item_id });
    if (item.kind === "document") return captureInlineDocumentCleanup(db, { documentIds: [item.item_id] });
    return [];
}

type ResolveActor = ArchiveActor & { archiveId: string; successorId?: unknown; delete: boolean };

export async function resolveDepartureArchive(db: Db, actor: ResolveActor): Promise<ServiceResult<null>> {
    const denied = await requireOwner(db, actor);
    if (denied) return denied;
    return resolveArchive(db, actor);
}

/**
 * Reassign or delete several archived items in one request. Each item is its
 * own transaction, so the count says how far it got: `unresolved` items hit a
 * conflict (their recovery period ended) and are still archived.
 */
export async function resolveDepartureArchives(
    db: Db,
    actor: ArchiveActor & { archiveIds: unknown; successorId?: unknown; delete: boolean },
): Promise<ServiceResult<OrgDepartureResolution>> {
    const denied = await requireOwner(db, actor);
    if (denied) return denied;
    const ids = Array.isArray(actor.archiveIds) ? [...new Set(actor.archiveIds as unknown[])] : [];
    if (!ids.length || ids.length > BULK_ARCHIVE_LIMIT || !ids.every((id) => typeof id === "string" && UUID.test(id))) {
        return failure("validation", `Choose between 1 and ${BULK_ARCHIVE_LIMIT} archived items.`);
    }
    let resolved = 0, unresolved = 0;
    for (const archiveId of ids as string[]) {
        const result = await resolveArchive(db, { ...actor, archiveId });
        if (result.ok) resolved += 1;
        // Already gone: a library file follows the chat or review that used
        // it, and another owner may have dealt with the item meanwhile.
        else if (result.kind === "not_found") continue;
        else if (result.kind === "conflict") unresolved += 1;
        // True of every remaining item too (no successor, not an owner), or
        // unexpected: stop here with what was already done standing.
        else return result;
    }
    return ok({ resolved, unresolved });
}

async function resolveArchive(db: Db, actor: ResolveActor): Promise<ServiceResult<null>> {
    if (!actor.delete && (typeof actor.successorId !== "string" || !actor.successorId)) {
        return failure("validation", "Choose a member to own the recovered work.");
    }
    const { data: item, error: readError } = await db.from("org_departure_archives")
        .select("kind, item_id").eq("org_id", actor.orgId).eq("id", actor.archiveId).maybeSingle();
    if (readError) return internalFailure(readError);
    if (!item) return failure("not_found", "Archived item not found.");
    const keys = actor.delete ? await cleanupKeys(db, item as OrgDepartureArchive) : [];
    const { error } = await db.rpc("resolve_org_departure_archive", {
        p_org_id: actor.orgId, p_archive_id: actor.archiveId, p_actor_id: actor.userId,
        p_successor_id: actor.delete ? null : actor.successorId, p_delete: actor.delete,
    });
    if (error?.code === "42501") return failure("forbidden", "Only organization owners can manage archived work.");
    if (error?.code === "P0002") return failure("not_found", "Archived item not found.");
    if (error?.code === "23514") return failure("conflict", "The recovery period has ended or the selected member is no longer available. Refresh and try again.");
    if (error?.code === "22P02") return failure("validation", "Choose a current organization member.");
    if (error) return internalFailure(error);
    if (actor.delete) await completeInlineDocumentCleanup(db, keys);
    return ok(null);
}

/** Bounded, retryable sweep; the database serializes recovery against expiry. */
export async function expireDepartureArchives(db: Db): Promise<number> {
    const { data: expired, error: readError } = await db.from("org_departure_archives")
        .select("kind, item_id").lte("expires_at", new Date().toISOString())
        .order("expires_at").order("id").limit(100);
    if (readError) throw new AppError("db.query_failed", "Could not load expired organization archives", { cause: readError });
    const keys: string[] = [];
    for (const item of (expired ?? []) as OrgDepartureArchive[]) keys.push(...await cleanupKeys(db, item));
    const { data, error } = await db.rpc("expire_org_departure_archives", { p_limit: 100 });
    if (error) throw new AppError("db.query_failed", "Could not expire organization archives", { cause: error });
    await completeInlineDocumentCleanup(db, keys);
    return Number(data ?? 0);
}
