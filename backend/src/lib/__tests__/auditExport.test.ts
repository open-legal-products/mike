import { describe, it, expect } from "vitest";
import {
    AUDIT_EXPORT_LIMIT,
    buildAuditCsv,
    parseQuery,
    queryEvents,
} from "../auditExport";

// Chainable Supabase double: no accessible projects, and one fixed page of
// audit rows for the export query. Enough to exercise CSV assembly.
function makeDb(events: Record<string, unknown>[], error?: { message: string }) {
    const ranges: [number, number][] = [];
    function builder() {
        const b: Record<string, unknown> = {
            select: () => b,
            or: () => b,
            eq: () => b,
            // The project scope resolves through lib/access now, which also
            // composes .is()/.in() and .maybeSingle(). Every table still
            // answers "no rows", so the caller sees no accessible projects.
            is: () => b,
            in: () => b,
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
            ilike: () => b,
            gte: () => b,
            lte: () => b,
            order: () => b,
            range: (from: number, to: number) => {
                ranges.push([from, to]);
                return Promise.resolve({
                    data: error ? null : events,
                    error: error ?? null,
                    count: events.length,
                });
            },
            then: (resolve: (v: unknown) => unknown) =>
                Promise.resolve({ data: [], error: null }).then(resolve),
        };
        return b;
    }
    return { db: { from: () => builder() } as never, ranges };
}

const QUERY = parseQuery({}, AUDIT_EXPORT_LIMIT);
const query = QUERY.ok ? QUERY.query : (undefined as never);

describe("buildAuditCsv", () => {
    // Display names are not resolved for the export (queryEvents is called
    // with resolveDisplayNames=false), so the "user" column is the email.
    it("emits the header and one row per event", async () => {
        const { db } = makeDb([
            {
                created_at: "2026-08-10T08:30:00.000Z",
                user_email: "lawyer@example.com",
                action: "document.edited",
                status: "completed",
                title: "Share purchase agreement",
                surface: "project",
                project_id: "p1",
                model: "gpt-5",
            },
        ]);
        const csv = await buildAuditCsv(db, "u1", "u1@example.com", query);
        expect(csv.split("\n")).toEqual([
            "created_at,user,action,status,title,application,project_id,model",
            "2026-08-10T08:30:00.000Z,lawyer@example.com,document.edited,completed,Share purchase agreement,project,p1,gpt-5",
        ]);
    });

    it("neutralizes spreadsheet formulas smuggled in through a title", async () => {
        const { db } = makeDb([
            { title: '=HYPERLINK("http://evil","click")', user_email: "a@b.test" },
        ]);
        const csv = await buildAuditCsv(db, "u1", undefined, query);
        // Leading single quote forces Excel/Sheets to treat it as literal text.
        expect(csv).toContain('"\'=HYPERLINK(""http://evil"",""click"")"');
    });

    it("always reads page 1 — the export is one flat window", async () => {
        const { db, ranges } = makeDb([]);
        await buildAuditCsv(db, "u1", undefined, { ...query, page: 7 });
        // The accessible-project scan pages from 0 as well; what matters is
        // that the EVENTS read is one flat window and nothing starts later.
        expect(ranges).toContainEqual([0, 999]);
        expect(ranges.every(([from]) => from === 0)).toBe(true);
    });

    it("throws on a query error so the export job retries", async () => {
        const dbError = { message: "connection reset", code: "57P01" };
        const { db } = makeDb([], dbError);
        // The original PostgrestError rides along as `cause` so the sync route
        // can log code/details/hint instead of just the message.
        await expect(buildAuditCsv(db, "u1", undefined, query)).rejects.toThrow(
            expect.objectContaining({
                message: "connection reset",
                cause: dbError,
            }),
        );
    });
});

// Table-aware double for the display-name path: `projects` (nothing shared),
// `audit_events` (one fixed page) and `user_profiles` (the name lookup).
function makeProfileDb(
    events: Record<string, unknown>[],
    profiles: Record<string, unknown>[],
) {
    let profilesQueried = false;
    function from() {
        const b: Record<string, unknown> = {
            select: () => b,
            or: () => b,
            eq: () => b,
            // See makeDb: the project scope's .is() chain runs first and
            // finds nothing, so only the profile lookup below matters here.
            is: () => b,
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
            ilike: () => b,
            gte: () => b,
            lte: () => b,
            order: () => b,
            in: (column: string) => {
                // Only the profile lookup filters on user_id; every other
                // `.in()` (project ids for the events read) keeps chaining.
                if (column !== "user_id") return b;
                profilesQueried = true;
                return Promise.resolve({ data: profiles, error: null });
            },
            range: () =>
                Promise.resolve({
                    data: events,
                    error: null,
                    count: events.length,
                }),
            then: (resolve: (v: unknown) => unknown) =>
                Promise.resolve({ data: [], error: null }).then(resolve),
        };
        return b;
    }
    return {
        db: { from } as never,
        wasProfileLookupRun: () => profilesQueried,
    };
}

describe("queryEvents display names", () => {
    const events = [
        { id: "e1", user_id: "u1", user_email: "lawyer@example.com" },
        { id: "e2", user_id: "u2", user_email: "other@example.com" },
    ];

    it("attaches a trimmed display name and drops the raw user_id", async () => {
        const { db } = makeProfileDb(events, [
            { user_id: "u1", display_name: "  Ada Lovelace  " },
        ]);
        const { data } = await queryEvents(db, "u1", undefined, query);
        expect(data).toEqual([
            {
                id: "e1",
                user_email: "lawyer@example.com",
                user_display_name: "Ada Lovelace",
            },
            // No profile row for u2, so the JSON listing gets an explicit null
            // and the client falls back to the email.
            {
                id: "e2",
                user_email: "other@example.com",
                user_display_name: null,
            },
        ]);
    });

    it("skips the profile lookup when display names are not requested", async () => {
        const { db, wasProfileLookupRun } = makeProfileDb(events, [
            { user_id: "u1", display_name: "Ada Lovelace" },
        ]);
        const { data } = await queryEvents(db, "u1", undefined, query, false);
        expect(wasProfileLookupRun()).toBe(false);
        // queryEvents short-circuits to the raw page only on the error/empty
        // paths, so its return type is a union and only one member carries
        // user_display_name. This fixture always yields rows, so narrow to the
        // enriched member rather than reaching through the union.
        const rows = data as
            | { user_display_name: string | null }[]
            | null
            | undefined;
        expect(rows?.map((e) => e.user_display_name)).toEqual([null, null]);
    });
});

describe("audit CSV user column", () => {
    // The export deliberately skips display-name resolution, so the "user"
    // column is the email even when the author has a profile name. The
    // "audit-csv" export job renders through buildAuditCsv, so pinning this
    // here pins the export.
    it("falls back to the email and never resolves profile names", async () => {
        const { db, wasProfileLookupRun } = makeProfileDb(
            [
                {
                    created_at: "2026-08-10T08:30:00.000Z",
                    user_id: "u1",
                    user_email: "lawyer@example.com",
                    action: "document.edited",
                    status: "completed",
                    title: "Share purchase agreement",
                    surface: "project",
                    project_id: "p1",
                    model: "gpt-5",
                },
            ],
            [{ user_id: "u1", display_name: "Ada Lovelace" }],
        );
        const csv = await buildAuditCsv(db, "u1", undefined, query);
        expect(wasProfileLookupRun()).toBe(false);
        expect(csv.split("\n")).toEqual([
            "created_at,user,action,status,title,application,project_id,model",
            "2026-08-10T08:30:00.000Z,lawyer@example.com,document.edited,completed,Share purchase agreement,project,p1,gpt-5",
        ]);
    });
});

// Applies filters and ordered inclusive ranges before imposing the same row
// cap as PostgREST. Counts describe the full matching set, not the capped page.
function makePagedAuditDb(
    events: Record<string, unknown>[],
    options: { projectIds?: string[]; maxRows?: number; failAt?: number } = {},
) {
    const projectIds = options.projectIds ?? ["project"];
    const ranges: [number, number][] = [];
    return {
        ranges,
        db: {
            from(table: string) {
                let rows: Record<string, unknown>[] =
                    table === "audit_events"
                        ? [...events]
                        : table === "projects"
                          ? projectIds.map((id) => ({
                                id,
                                user_id: "u1",
                                org_id: null,
                            }))
                          : [];
                const ordering: { column: string; ascending: boolean }[] = [];
                const builder = {
                    select: () => builder,
                    eq(column: string, value: unknown) {
                        rows = rows.filter((row) => row[column] === value);
                        return builder;
                    },
                    is(column: string, value: unknown) {
                        return builder.eq(column, value);
                    },
                    in(column: string, values: unknown[]) {
                        rows = rows.filter((row) =>
                            values.includes(row[column]),
                        );
                        return builder;
                    },
                    or() {
                        rows = rows.filter((row) => row.user_id !== "u1");
                        return builder;
                    },
                    order(
                        column: string,
                        { ascending }: { ascending: boolean },
                    ) {
                        ordering.push({ column, ascending });
                        return builder;
                    },
                    range(from: number, to: number) {
                        if (table === "audit_events") ranges.push([from, to]);
                        if (table === "audit_events" && from === options.failAt)
                            return Promise.resolve({
                                data: null,
                                error: { message: "page failed" },
                                count: null,
                            });
                        const sorted = [...rows].sort((a, b) => {
                            for (const { column, ascending } of ordering) {
                                const left = a[column];
                                const right = b[column];
                                if (left === right) continue;
                                if (left == null) return 1;
                                if (right == null) return -1;
                                return (
                                    (left < right ? -1 : 1) *
                                    (ascending ? 1 : -1)
                                );
                            }
                            return 0;
                        });
                        return Promise.resolve({
                            data: sorted.slice(
                                from,
                                Math.min(
                                    to + 1,
                                    from + (options.maxRows ?? 1000),
                                ),
                            ),
                            error: null,
                            count: rows.length,
                        });
                    },
                    then(resolve: (result: unknown) => unknown) {
                        return Promise.resolve({
                            data: rows,
                            error: null,
                        }).then(resolve);
                    },
                };
                return builder;
            },
        } as never,
    };
}

const eventRows = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
        id: String(index).padStart(5, "0"),
        created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        user_id: "u1",
        user_email: "u1@example.com",
        project_id: "project",
    }));
const PAGE_QUERY = { ...query, sortDirection: "asc" as const, limit: 50 };

describe("audit pagination across capped partitions", () => {
    it("returns page 21 after a partition exceeds the 1,000-row response cap", async () => {
        const { db, ranges } = makePagedAuditDb(eventRows(1050));
        const result = await queryEvents(
            db,
            "u1",
            undefined,
            { ...PAGE_QUERY, page: 21 },
            false,
        );
        expect(result.count).toBe(1050);
        expect(result.data?.map((row) => row.id)).toEqual(
            eventRows(1050)
                .slice(1000)
                .map((row) => row.id),
        );
        expect(ranges).toContainEqual([1000, 1049]);
    });

    it("merges later pages from multiple project chunks and counts each event once", async () => {
        const events = eventRows(2200).map((event, index) => ({
            ...event,
            user_id: index % 2 ? null : "colleague",
            project_id: index % 2 ? "p200" : "p000",
        }));
        const { db } = makePagedAuditDb(events, {
            projectIds: Array.from(
                { length: 201 },
                (_, i) => `p${String(i).padStart(3, "0")}`,
            ),
        });
        const result = await queryEvents(
            db,
            "u1",
            undefined,
            { ...PAGE_QUERY, page: 43 },
            false,
        );
        expect(result.count).toBe(2200);
        expect(result.data?.map((row) => row.id)).toEqual(
            events.slice(2100, 2150).map((row) => row.id),
        );
    });

    it.each([true, false])(
        "exports 2,000 rows under the cap (accessible project: %s)",
        async (hasProject) => {
            const { db } = makePagedAuditDb(eventRows(2100), {
                projectIds: hasProject ? ["project"] : [],
                maxRows: 500,
            });
            const csv = await buildAuditCsv(db, "u1", undefined, query);
            expect(csv.split("\n")).toHaveLength(AUDIT_EXPORT_LIMIT + 1);
        },
    );

    it("returns a later partition-page failure instead of partial audit history", async () => {
        const { db } = makePagedAuditDb(eventRows(1050), { failAt: 1000 });
        const result = await queryEvents(
            db,
            "u1",
            undefined,
            { ...PAGE_QUERY, page: 21 },
            false,
        );
        expect(result.error?.message).toBe("page failed");
        expect(result.data).toBeNull();
    });

    it("preserves the 10,000-row merge window and exact total", async () => {
        const { db } = makePagedAuditDb(eventRows(10050));
        const last = await queryEvents(
            db,
            "u1",
            undefined,
            { ...PAGE_QUERY, page: 200 },
            false,
        );
        expect(last.data).toHaveLength(50);
        const beyond = await queryEvents(
            db,
            "u1",
            undefined,
            { ...PAGE_QUERY, page: 201 },
            false,
        );
        expect(beyond.data).toEqual([]);
        expect(beyond.count).toBe(10050);
    });
});

describe("audit pagination with tied sort values", () => {
    it.each(["asc", "desc"] as const)(
        "uses the same ID tie-break on every %s page",
        async (sortDirection) => {
            const events = eventRows(100).reverse();
            const { db } = makePagedAuditDb(events);
            const sortedQuery = {
                ...PAGE_QUERY,
                sortBy: "user_email" as const,
                sortDirection,
            };
            const first = await queryEvents(
                db,
                "u1",
                undefined,
                { ...sortedQuery, page: 1 },
                false,
            );
            const second = await queryEvents(
                db,
                "u1",
                undefined,
                { ...sortedQuery, page: 2 },
                false,
            );
            const actual = [...(first.data ?? []), ...(second.data ?? [])].map(
                (row) => row.id,
            );
            expect(actual).toEqual(eventRows(100).map((row) => row.id));
        },
    );
});
