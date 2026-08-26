import { describe, it, expect } from "vitest";
import {
    csvCell,
    escapeLikePattern,
    parseQuery,
    queryEvents,
} from "../audit";
import { listAccessibleProjectIds } from "../../lib/access";

// ---------------------------------------------------------------------------
// csvCell — spreadsheet formula-injection escaping (F3)
// ---------------------------------------------------------------------------

describe("csvCell", () => {
    it("prefixes a single quote to values that begin with a formula trigger", () => {
        for (const trigger of ["=", "+", "-", "@", "\t", "\r"]) {
            const payload = `${trigger}HYPERLINK("http://evil","x")`;
            const cell = csvCell(payload);
            // Leading quote neutralizes evaluation; the whole value is then
            // quoted because it contains characters requiring CSV quoting.
            expect(cell.startsWith(`"'${trigger}`)).toBe(true);
        }
    });

    it("neutralizes a bare leading = even without other special chars", () => {
        expect(csvCell("=1")).toBe("'=1");
    });

    it("quotes and escapes embedded quotes, commas, and newlines", () => {
        expect(csvCell("a,b")).toBe('"a,b"');
        expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
        expect(csvCell("line1\r\nline2")).toBe('"line1\r\nline2"');
    });

    it("leaves ordinary values untouched and renders null as empty", () => {
        expect(csvCell("brief.docx")).toBe("brief.docx");
        expect(csvCell(null)).toBe("");
        expect(csvCell(undefined)).toBe("");
    });
});

// ---------------------------------------------------------------------------
// parseQuery — page clamping (F7) + date validation (F8)
// ---------------------------------------------------------------------------

describe("parseQuery", () => {
    it("clamps an absurd page so the offset can't overflow", () => {
        const result = parseQuery({ page: "99999999999999" }, 50);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.query.page).toBe(100_000);
            // offset stays well within Postgres' integer range.
            expect((result.query.page - 1) * result.query.limit).toBeLessThan(
                2_147_483_647,
            );
        }
    });

    it("floors non-positive or non-numeric pages to 1", () => {
        for (const page of ["0", "-5", "abc", ""]) {
            const result = parseQuery({ page }, 50);
            expect(result.ok && result.query.page).toBe(1);
        }
    });

    it("rejects from/to that are not bare YYYY-MM-DD", () => {
        expect(parseQuery({ to: "2026-07-30T12:00:00Z" }, 50)).toEqual({
            ok: false,
            error: expect.stringContaining("to"),
        });
        expect(parseQuery({ from: "not-a-date" }, 50)).toEqual({
            ok: false,
            error: expect.stringContaining("from"),
        });
    });

    it("accepts well-formed dates and trims free-text filters", () => {
        const result = parseQuery(
            {
                from: "2026-07-01",
                to: "2026-07-31",
                q: "  hello  ",
                action: " chat.message ",
                status: " completed ",
                surface: " project ",
                sort_by: "title",
                sort_dir: "asc",
            },
            50,
        );
        expect(result).toMatchObject({
            ok: true,
            query: {
                from: "2026-07-01",
                to: "2026-07-31",
                q: "hello",
                action: "chat.message",
                status: "completed",
                surface: "project",
                sortBy: "title",
                sortDirection: "asc",
            },
        });
    });

    it("rejects unsupported sort fields and directions", () => {
        expect(parseQuery({ sort_by: "detail" }, 50)).toEqual({
            ok: false,
            error: "Invalid audit sort field",
        });
        expect(parseQuery({ sort_dir: "sideways" }, 50)).toEqual({
            ok: false,
            error: "Invalid audit sort direction",
        });
    });
});

// ---------------------------------------------------------------------------
// queryEvents / listAccessibleProjectIds — visibility scoping
// ---------------------------------------------------------------------------

/**
 * Chainable Supabase mock. `projects` select responses are keyed by whether the
 * query used .eq (owned) or .filter (shared_with contains). The audit_events
 * builder records the .or / .eq filter it was given so tests can assert
 * scoping.
 */
function makeDb(
    owned: string[],
    shared: string[],
    events: Record<string, unknown>[] = [],
    profiles: Record<string, unknown>[] = [],
) {
    const calls: {
        or?: string;
        eq: [string, unknown][];
        order?: [string, { ascending: boolean; nullsFirst: boolean }];
        ilike?: [string, string];
        profileUserIds?: string[];
    } = { eq: [] };

    function projectsBuilder() {
        let mode: "owned" | "shared" = "owned";
        const b: any = {
            select: () => b,
            eq: () => {
                mode = "owned";
                return b;
            },
            filter: () => {
                mode = "shared";
                return b;
            },
            neq: () => b,
            then: (resolve: (v: { data: { id: string }[] }) => unknown) =>
                Promise.resolve({
                    data: (mode === "owned" ? owned : shared).map((id) => ({
                        id,
                    })),
                }).then(resolve),
        };
        return b;
    }

    function auditBuilder() {
        const b: any = {
            select: () => b,
            or: (expr: string) => {
                calls.or = expr;
                return b;
            },
            eq: (col: string, val: unknown) => {
                calls.eq.push([col, val]);
                return b;
            },
            ilike: (column: string, pattern: string) => {
                calls.ilike = [column, pattern];
                return b;
            },
            gte: () => b,
            lte: () => b,
            order: (
                column: string,
                options: { ascending: boolean; nullsFirst: boolean },
            ) => {
                calls.order = [column, options];
                return b;
            },
            range: () =>
                Promise.resolve({
                    data: events,
                    error: null,
                    count: events.length,
                }),
        };
        return b;
    }

    function profilesBuilder() {
        const b: any = {
            select: () => b,
            in: (_column: string, userIds: string[]) => {
                calls.profileUserIds = userIds;
                return Promise.resolve({ data: profiles, error: null });
            },
        };
        return b;
    }

    const db = {
        from(table: string) {
            if (table === "projects") return projectsBuilder();
            if (table === "user_profiles") return profilesBuilder();
            return auditBuilder();
        },
    };
    return { db: db as any, calls };
}

describe("queryEvents visibility scoping", () => {
    const query = {
        page: 1,
        limit: 50,
        sortBy: "created_at",
        sortDirection: "desc",
    } as const;

    it("scopes to own events OR accessible project events (owned + shared)", async () => {
        const { db, calls } = makeDb(["p-own"], ["p-shared"]);
        await queryEvents(db, "u1", "u1@example.com", query);
        expect(calls.or).toBe("user_id.eq.u1,project_id.in.(p-own,p-shared)");
        expect(calls.eq).toEqual([]);
    });

    it("falls back to own-events-only when no projects are accessible", async () => {
        const { db, calls } = makeDb([], []);
        await queryEvents(db, "u1", "u1@example.com", query);
        expect(calls.or).toBeUndefined();
        expect(calls.eq).toContainEqual(["user_id", "u1"]);
    });

    it("de-duplicates owned and shared project ids", async () => {
        const both = await listAccessibleProjectIds(
            "u1",
            "u1@example.com",
            makeDb(["p1", "p2"], ["p2", "p3"]).db,
        );
        expect([...both].sort()).toEqual(["p1", "p2", "p3"]);
    });

    it("applies categorical filters and the requested sort", async () => {
        const { db, calls } = makeDb([], []);
        await queryEvents(db, "u1", "u1@example.com", {
            ...query,
            action: "document.uploaded",
            status: "completed",
            surface: "project",
            q: "agreement\\draft_100%",
            sortBy: "title",
            sortDirection: "asc",
        });

        expect(calls.eq).toEqual(
            expect.arrayContaining([
                ["user_id", "u1"],
                ["action", "document.uploaded"],
                ["status", "completed"],
                ["surface", "project"],
            ]),
        );
        expect(calls.order).toEqual([
            "title",
            { ascending: true, nullsFirst: false },
        ]);
        expect(calls.ilike).toEqual([
            "title",
            "%agreement\\\\draft\\_100\\%%",
        ]);
    });

    it("resolves display names for only the users on the requested page", async () => {
        const events = [
            {
                id: "event-1",
                user_id: "u1",
                user_email: "one@example.com",
            },
            {
                id: "event-2",
                user_id: "u2",
                user_email: "two@example.com",
            },
        ];
        const { db, calls } = makeDb([], [], events, [
            { user_id: "u1", display_name: "  Alex Lawyer  " },
        ]);

        const result = await queryEvents(db, "u1", "one@example.com", query);

        expect(calls.profileUserIds).toEqual(["u1", "u2"]);
        expect(result.data).toEqual([
            {
                id: "event-1",
                user_email: "one@example.com",
                user_display_name: "Alex Lawyer",
            },
            {
                id: "event-2",
                user_email: "two@example.com",
                user_display_name: null,
            },
        ]);
    });

    it("can skip profile resolution for the larger export query", async () => {
        const { db, calls } = makeDb(
            [],
            [],
            [{ id: "event-1", user_id: "u1", user_email: "one@example.com" }],
        );

        const result = await queryEvents(
            db,
            "u1",
            "one@example.com",
            query,
            false,
        );

        expect(calls.profileUserIds).toBeUndefined();
        expect(result.data).toEqual([
            {
                id: "event-1",
                user_email: "one@example.com",
                user_display_name: null,
            },
        ]);
    });
});
