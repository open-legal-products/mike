// Audit-history querying + CSV assembly.
//
// This lives in lib/ because two modules need it: the audit module's paginated
// GET /audit, and the user module's "audit-csv" export job, which runs in a
// worker where importing an Express router would drag in the whole HTTP
// surface.

import { getOrgRole, isOrgAdmin } from "./access";
import { mapWithConcurrency } from "./concurrency";
import { normalizeDisplayName, normalizeEmail } from "./userLookup";
import type { Db } from "./supabase";

/** One CSV export is a single flat page; this caps the artifact size. */
export const AUDIT_EXPORT_LIMIT = 2000;
// Clamp the requested page. Without a bound, ?page=99999999999999 produces an
// offset of ~5e15, which PostgREST rejects and surfaces as a 500. Capping the
// page keeps the offset well inside Postgres' integer range.
const MAX_PAGE = 100_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AuditQuery = {
    orgId?: string;
    userName?: string;
    actorUserId?: string;
    eventIds?: string[];
    q?: string;
    action?: string;
    status?: string;
    surface?: string;
    from?: string;
    to?: string;
    sortBy: AuditSortField;
    sortDirection: "asc" | "desc";
    page: number;
    limit: number;
};

const AUDIT_SORT_FIELDS = [
    "created_at",
    "user_email",
    "title",
    "model",
] as const;
type AuditSortField = (typeof AUDIT_SORT_FIELDS)[number];

export type ParseQueryResult =
    | { ok: true; query: AuditQuery }
    | { ok: false; error: string };

export function escapeLikePattern(value: string): string {
    return value
        .replace(/\\/g, "\\\\")
        .replace(/%/g, "\\%")
        .replace(/_/g, "\\_");
}

export function parseQuery(
    raw: Record<string, unknown>,
    limit: number,
): ParseQueryResult {
    const str = (v: unknown) =>
        typeof v === "string" && v.trim() ? v.trim() : undefined;
    // Clamp page into [1, MAX_PAGE] so a huge ?page= can't overflow the offset.
    const parsedPage = Number.parseInt(String(raw.page ?? "1"), 10) || 1;
    const page = Math.min(Math.max(parsedPage, 1), MAX_PAGE);
    const orgId = str(raw.org_id);
    if (raw.org_id !== undefined && (!orgId || !UUID_RE.test(orgId)))
        return { ok: false, error: "Invalid organization id" };
    if (raw.username !== undefined && typeof raw.username !== "string")
        return { ok: false, error: "Invalid username filter" };
    const userName = str(raw.username)?.slice(0, 200);
    const actorUserId = str(raw.actor_user_id);
    if (raw.actor_user_id !== undefined && (!actorUserId || !UUID_RE.test(actorUserId)))
        return { ok: false, error: "Invalid audit actor id" };
    if (actorUserId && !orgId)
        return { ok: false, error: "Actor filtering requires an organization" };
    if (userName && !orgId)
        return { ok: false, error: "Username filtering requires an organization" };
    let eventIds: string[] | undefined;
    if (raw.event_ids !== undefined) {
        if (!Array.isArray(raw.event_ids) || raw.event_ids.length === 0 ||
            raw.event_ids.length > AUDIT_EXPORT_LIMIT ||
            raw.event_ids.some((id) => typeof id !== "string" || !UUID_RE.test(id))) {
            return { ok: false, error: `Select between 1 and ${AUDIT_EXPORT_LIMIT} valid audit events` };
        }
        eventIds = [...new Set(raw.event_ids.map((id: string) => id.toLowerCase()))];
    }
    const from = str(raw.from);
    const to = str(raw.to);
    const requestedSortBy = str(raw.sort_by);
    const requestedSortDirection = str(raw.sort_dir);
    // Date filters come from <input type="date"> and are compared as calendar
    // days. Reject anything that isn't a bare YYYY-MM-DD — a value like
    // "2026-07-30T12:00:00Z" would become "...ZT23:59:59.999Z" (F8) and 500.
    if (from && !DATE_RE.test(from))
        return { ok: false, error: "Invalid 'from' date; expected YYYY-MM-DD" };
    if (to && !DATE_RE.test(to))
        return { ok: false, error: "Invalid 'to' date; expected YYYY-MM-DD" };
    if (
        requestedSortBy &&
        !AUDIT_SORT_FIELDS.includes(requestedSortBy as AuditSortField)
    ) {
        return { ok: false, error: "Invalid audit sort field" };
    }
    if (
        requestedSortDirection &&
        requestedSortDirection !== "asc" &&
        requestedSortDirection !== "desc"
    ) {
        return { ok: false, error: "Invalid audit sort direction" };
    }
    return {
        ok: true,
        query: {
            ...(orgId ? { orgId } : {}),
            ...(userName ? { userName } : {}),
            ...(actorUserId ? { actorUserId } : {}),
            ...(eventIds ? { eventIds } : {}),
            q: str(raw.q)?.slice(0, 200),
            action: str(raw.action)?.slice(0, 60),
            status: str(raw.status)?.slice(0, 20),
            surface: str(raw.surface)?.slice(0, 30),
            from,
            to,
            sortBy:
                (requestedSortBy as AuditSortField | undefined) ?? "created_at",
            sortDirection:
                (requestedSortDirection as "asc" | "desc" | undefined) ??
                "desc",
            page,
            limit,
        },
    };
}

/** Selected-event IDs per personal-history request, below proxy URL limits. */
const ID_FILTER_CHUNK = 200;

/**
 * Deepest page the chunked read will assemble in memory.
 *
 * Chunking means the database can no longer apply one OFFSET for the whole
 * result set: each chunk is ordered independently and the pages are merged
 * here, so serving offset N costs N rows per chunk. `page` is already clamped
 * to MAX_PAGE, which at 50 rows a page would be 5,000,000 rows — so bound the
 * merge window too. Beyond it the page is empty; `total` is still exact, and
 * the answer to "I need row 10,001" is a narrower filter or the CSV export.
 */
const MERGE_WINDOW_ROWS = 10_000;

const AUDIT_EVENT_COLUMNS =
    "id, org_id, created_at, user_id, user_email, action, status, title, surface, project_id, chat_id, document_id, review_id, model, detail";

type AuditRow = Record<string, unknown>;

/** A person explicitly identified by an authorized member/invitation event. */
function affectedUser(
    event: AuditRow,
): { column: "user_id" | "email"; value: string } | null {
    const action = String(event.action ?? "");
    if (
        !action.startsWith("org.member.") &&
        !action.startsWith("org.invite.") &&
        action !== "org.private_content.permission_changed" &&
        action !== "org.departure.member.departed"
    ) return null;
    const detail = event.detail as Record<string, unknown> | null;
    const id = typeof detail?.target_user_id === "string"
        ? detail.target_user_id.trim()
        : "";
    if (id) return { column: "user_id", value: id };
    const email = normalizeEmail(detail?.target_email ?? event.title);
    return /^[^\s@]+@[^\s@]+$/.test(email) ? { column: "email", value: email } : null;
}

/** Resolve current names without changing the event's recorded identity. */
async function affectedUserNames(db: Db, events: AuditRow[]) {
    const targets = events.map(affectedUser).filter((target) => target !== null);
    const names = new Map<string, string>();
    for (const column of ["user_id", "email"] as const) {
        const values = [...new Set(targets
            .filter((target) => target.column === column)
            .map((target) => target.value))];
        for (const batch of chunk(values, ID_FILTER_CHUNK)) {
            // Fetch names only, scoped to affected people on the final authorized
            // page. An ID never falls back to email, which may have changed owners.
            const { data, error } = await db.from("user_profiles")
                .select("user_id, email, display_name")
                .in(column, batch);
            if (error) continue; // The recorded identity remains the fallback.
            for (const profile of data ?? []) {
                const name = normalizeDisplayName(profile.display_name);
                const key = column === "email"
                    ? normalizeEmail(profile.email)
                    : profile.user_id;
                if (name) names.set(`${column}:${key}`, name);
            }
        }
    }
    return names;
}

type EventsResult = {
    data: AuditRow[] | null;
    error: { message: string } | null;
    count?: number | null;
};

/**
 * The slice of the PostgREST builder this query uses. Spelled out rather than
 * inferred: the generated Supabase types recurse through every filter method,
 * and threading them through a helper that applies six of them in a loop
 * makes the checker give up ("type instantiation is excessively deep").
 */
type EventsQuery = {
    eq(column: string, value: unknown): EventsQuery;
    in(column: string, values: unknown[]): EventsQuery;
    ilike(column: string, pattern: string): EventsQuery;
    gte(column: string, value: unknown): EventsQuery;
    lte(column: string, value: unknown): EventsQuery;
    order(
        column: string,
        options: { ascending: boolean; nullsFirst: boolean },
    ): EventsQuery;
    range(from: number, to: number): PromiseLike<EventsResult>;
};

function chunk<T>(values: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
    return out;
}

// PostgREST caps each response independently of the requested range. Read
// through the complete requested window, advancing by the actual row count so
// deployments with a lower cap work too. A failed page invalidates the result.
const AUDIT_READ_PAGE_SIZE = 1000;

async function readEventWindow(
    makeQuery: () => Pick<EventsQuery, "range">,
    from: number,
    limit: number,
): Promise<EventsResult> {
    const rows: AuditRow[] = [];
    let count: number | null = null;
    while (rows.length < limit) {
        const offset = from + rows.length;
        const to =
            offset + Math.min(AUDIT_READ_PAGE_SIZE, limit - rows.length) - 1;
        const result = await makeQuery().range(offset, to);
        if (result.error) return { ...result, data: null };
        count ??= result.count ?? null;
        const batch = result.data ?? [];
        rows.push(...batch);
        if (!batch.length || (count !== null && from + rows.length >= count))
            break;
    }
    return { data: rows, error: null, count };
}

/** Order two rows the way the database was asked to order them. */
function compareRows(a: AuditRow, b: AuditRow, q: AuditQuery): number {
    const left = a[q.sortBy];
    const right = b[q.sortBy];
    // nullsFirst: false — a missing value sorts last in BOTH directions,
    // which is what PostgREST was told and what Postgres then does.
    const leftMissing = left === null || left === undefined;
    const rightMissing = right === null || right === undefined;
    if (leftMissing || rightMissing) {
        if (leftMissing && rightMissing) return String(a.id).localeCompare(String(b.id));
        return leftMissing ? 1 : -1;
    }
    const direction = q.sortDirection === "asc" ? 1 : -1;
    if (left < right) return -1 * direction;
    if (left > right) return 1 * direction;
    // Stable tie-break so the same row never appears on two pages.
    return String(a.id).localeCompare(String(b.id));
}

export async function canReadOrgAudit(db: Db, userId: string, orgId: string): Promise<boolean> {
    const role = await getOrgRole(userId, orgId, db);
    return role !== null && isOrgAdmin(role);
}

export async function queryEvents(
    db: Db,
    userId: string,
    email: string | undefined,
    q: AuditQuery,
    resolveDisplayNames = true,
) {
    // Organization access must fail closed. Personal
    // activity is scoped directly to its actor, independent of project access.
    try {
        if (q.orgId && !(await canReadOrgAudit(db, userId, q.orgId))) {
            return { data: null, error: { message: "Organization audit access denied" }, count: null } satisfies EventsResult;
        }
    } catch (err) {
        // Hand back the underlying PostgREST error when there is one, so the
        // route's log and the CSV job's retry see code/details/hint exactly
        // as they would for a failed events read.
        const cause =
            err instanceof Error && err.cause && typeof err.cause === "object"
                ? (err.cause as { message?: string | null })
                : null;
        return {
            data: null,
            error: cause?.message
                ? (cause as { message: string })
                : {
                      message:
                          err instanceof Error
                              ? err.message
                              : "audit scope read failed",
                  },
            count: null,
        } satisfies EventsResult;
    }

    const applyFilters = (query: EventsQuery): EventsQuery => {
        let next = query;
        if (q.action) next = next.eq("action", q.action);
        if (q.status) next = next.eq("status", q.status);
        if (q.surface) next = next.eq("surface", q.surface);
        if (q.q) next = next.ilike("title", `%${escapeLikePattern(q.q)}%`);
        if (q.from) next = next.gte("created_at", q.from);
        if (q.to) next = next.lte("created_at", `${q.to}T23:59:59.999Z`);
        return next.order(q.sortBy, {
            ascending: q.sortDirection === "asc",
            nullsFirst: false,
        }).order("id", { ascending: true, nullsFirst: false });
    };

    const base = () => db.from("audit_events")
        .select(AUDIT_EVENT_COLUMNS, { count: "exact" }) as unknown as EventsQuery;

    const offset = (q.page - 1) * q.limit;
    let result: EventsResult;

    // Organization RPCs send selected IDs in a JSON body. Personal queries
    // retain bounded URL partitions; username matching stays inside org SQL.
    const eventChunks = q.orgId ? [q.eventIds]
        : q.eventIds ? chunk(q.eventIds, ID_FILTER_CHUNK) : [undefined];
    const queries = eventChunks.map((eventIds) => () => {
        if (q.orgId) {
            return {
                range: async (from: number, to: number): Promise<EventsResult> => {
                    // Pagination must happen inside the RPC, before its
                    // resource joins and access checks. PostgREST's outer
                    // range cannot push through a function with SET.
                    const { data, error } = await db.rpc("organization_audit_events_page", {
                        p_org_id: q.orgId,
                        p_actor_id: userId,
                        p_actor_email: email ?? null,
                        p_filter: {
                            username_pattern: q.userName ? `%${escapeLikePattern(q.userName)}%` : undefined,
                            action: q.action,
                            status: q.status,
                            surface: q.surface,
                            actor_user_id: q.actorUserId,
                            title_pattern: q.q ? `%${escapeLikePattern(q.q)}%` : undefined,
                            from: q.from,
                            to: q.to ? `${q.to}T23:59:59.999Z` : undefined,
                            ...(eventIds ? { event_ids: eventIds } : {}),
                        },
                        p_sort_by: q.sortBy,
                        p_sort_direction: q.sortDirection,
                        p_offset: from,
                        p_limit: to - from + 1,
                    });
                    const page = data as { events: AuditRow[]; total: number } | null;
                    return { data: page?.events ?? null, count: page?.total ?? null, error };
                },
            };
        }
        let query = base().eq("user_id", userId);
        if (eventIds) query = query.in("id", eventIds);
        return applyFilters(query);
    });

    if (queries.length === 1) {
        result = await readEventWindow(queries[0], offset, q.limit);
    } else {
        // Distinct selected-event partitions are disjoint,
        // so their exact counts can be summed before merging the sorted rows.
        const window = Math.min(offset + q.limit, MERGE_WINDOW_ROWS);
        const responses = await mapWithConcurrency(queries, 4, (makeQuery) =>
            readEventWindow(makeQuery, 0, window),
        );

        const failed = responses.find((response) => response.error);
        if (failed) return failed;

        const merged = new Map<string, AuditRow>();
        let count = 0;
        for (const response of responses) {
            count += response.count ?? 0;
            for (const row of response.data ?? [])
                merged.set(String(row.id), row);
        }
        const rows = [...merged.values()].sort((a, b) => compareRows(a, b, q));
        // Each partition contributed its own top-`window` rows, so the merged
        // order is only guaranteed for the first `window` positions. A page
        // that starts past the window is empty (as the constant's comment
        // promises), and a page that straddles it is cut at the window rather
        // than filled from rows whose global position is unknown.
        result = {
            data:
                offset >= window
                    ? []
                    : rows.slice(offset, Math.min(offset + q.limit, window)),
            error: null,
            count,
        };
    }

    if (result.error || !result.data?.length) return result;

    const userIds = [
        ...new Set(
            result.data
                .map((event) => event.user_id as string | null)
                .filter((userId): userId is string => Boolean(userId)),
        ),
    ];
    const displayNameByUserId = new Map<string, string | null>();
    const photoByUserId = new Map<string, string | null>();
    if (resolveDisplayNames && userIds.length) {
        // Photos belong only to actors on this authorized organization page.
        // Personal activity omits identities, and CSV exports skip this lookup.
        const profilesQuery = db.from("user_profiles");
        const { data: profiles, error: profileError } = await (q.orgId
            ? profilesQuery.select("user_id, display_name, profile_photo")
            : profilesQuery.select("user_id, display_name")
        ).in("user_id", userIds);
        if (!profileError) {
            for (const profile of profiles ?? []) {
                displayNameByUserId.set(
                    profile.user_id as string,
                    normalizeDisplayName(profile.display_name),
                );
                if (q.orgId) {
                    photoByUserId.set(
                        profile.user_id as string,
                        (profile as { profile_photo?: string | null }).profile_photo ?? null,
                    );
                }
            }
        }
    }

    const affectedNames = resolveDisplayNames
        ? await affectedUserNames(db, result.data)
        : new Map<string, string>();

    return {
        ...result,
        // Annotated: the merged path's rows are `AuditRow` (an index
        // signature), and destructuring `user_id` out of one erases it, so
        // without this the callers lose every other column from the type.
        data: result.data.map((row): AuditRow => {
            const { user_id: userId, ...event } = row;
            const target = affectedUser(row);
            const affectedName = target && affectedNames.get(`${target.column}:${target.value}`);
            return {
                ...event,
                ...(affectedName ? { affected_user_display_name: affectedName } : {}),
                user_display_name:
                    displayNameByUserId.get(userId as string) ?? null,
                ...(q.orgId ? {
                    user_profile_photo: photoByUserId.get(userId as string) ?? null,
                } : {}),
            };
        }),
    };
}


export function csvCell(v: unknown): string {
    let s = v == null ? "" : String(v);
    // Neutralize spreadsheet formula injection: Excel/Sheets evaluate any cell
    // whose text begins with = + - @, a tab or a carriage return as a formula on
    // open. Titles are attacker-controllable across shared projects, so an
    // =HYPERLINK(...) payload would execute in the victim's spreadsheet. Prefix a
    // single quote to force the value to be treated as literal text.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const AUDIT_CSV_FILENAME = "my-activity.csv";

/**
 * Render the caller's visible audit events as a CSV document. Throws on a
 * query error so the async export job retries (the sync route turns the throw
 * back into its 500).
 */
export async function buildAuditCsv(
    db: Db,
    userId: string,
    userEmail: string | undefined,
    query: AuditQuery,
): Promise<string> {
    // Always page 1: the export is one flat window of up to `limit` rows, and
    // display names are skipped because the CSV falls back to user_email.
    const { data, error } = await queryEvents(
        db,
        userId,
        userEmail,
        { ...query, page: 1 },
        false,
    );
    // `cause` keeps the PostgrestError (code/details/hint) attached so the
    // sync route can log it exactly as it did before this helper existed.
    if (error) throw new Error(error.message, { cause: error });
    const header =
        "created_at,user,action,status,title,application,project_id,model" + (query.orgId ? ",organization_id" : "");
    const rows = ((data ?? []) as Record<string, unknown>[]).map((e) =>
        [
            e.created_at,
            e.user_display_name ?? e.user_email,
            e.action,
            e.status,
            e.title,
            e.surface,
            e.project_id,
            e.model,
            ...(query.orgId ? [e.org_id] : []),
        ]
            .map(csvCell)
            .join(","),
    );
    return [header, ...rows].join("\n");
}
