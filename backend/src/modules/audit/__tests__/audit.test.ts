import { describe, it, expect } from "vitest";
import {
    csvCell,
    parseQuery,
    queryEvents,
} from "../audit.service";
import { listAccessibleProjectIds } from "../../../lib/access";

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
 * Chainable Supabase mock.
 *
 * `owned` answers the personal `projects` lookup, `shared` answers the
 * `project_access_grants` lookup (where direct sharing lives), and `org`
 * supplies the third branch: the caller's memberships, that org's projects,
 * and any per-project deny override.
 *
 * The project-access helper tests below compose .eq/.in/.is chains across
 * these tables. Personal activity no longer consults that helper.
 */
type Filters = {
    eq: Record<string, unknown>;
    in: Record<string, unknown>;
    is: Record<string, unknown>;
};

function makeDb(
    owned: string[],
    shared: string[],
    events: Record<string, unknown>[] = [],
    profiles: Record<string, unknown>[] = [],
    org: {
        memberships?: { org_id: string; role: string }[];
        projects?: { id: string; user_id: string | null; org_id: string; visibility?: "private" | "organization" }[];
        denies?: string[];
    } = {},
) {
    const calls: {
        or?: string;
        in: [string, unknown][];
        eq: [string, unknown][];
        order?: [string, { ascending: boolean; nullsFirst: boolean }];
        ilike?: [string, string];
        profileUserIds?: string[];
        grantEmail?: unknown;
    } = { eq: [], in: [] };

    const memberships = org.memberships ?? [];
    const orgProjects = org.projects ?? [];
    const denied = new Set(org.denies ?? []);

    function filterBuilder(resolve: (filters: Filters) => unknown[]) {
        const filters: Filters = { eq: {}, in: {}, is: {} };
        const b: any = {
            select: () => b,
            eq: (column: string, value: unknown) => {
                if (column === "email") calls.grantEmail = value;
                filters.eq[column] = value;
                return b;
            },
            in: (column: string, value: unknown) => {
                filters.in[column] = value;
                return b;
            },
            is: (column: string, value: unknown) => {
                filters.is[column] = value;
                return b;
            },
            order: () => b,
            // listAccessibleProjectIds pages its scans; one page is enough here.
            range: () =>
                Promise.resolve({ data: resolve(filters), error: null }),
            maybeSingle: () =>
                Promise.resolve({
                    data: resolve(filters)[0] ?? null,
                    error: null,
                }),
            then: (resolveFn: (v: unknown) => unknown) =>
                Promise.resolve({ data: resolve(filters), error: null }).then(
                    resolveFn,
                ),
        };
        return b;
    }

    // Personal-owned, org-scoped, per-id and single-project lookups all hit
    // `projects`; only the filters tell them apart.
    const projectsResolver = (filters: Filters): unknown[] => {
        if (filters.eq.id)
            return orgProjects.filter(
                (project) => project.id === filters.eq.id,
            );
        if (filters.in.org_id)
            return orgProjects.filter((project) =>
                (filters.in.org_id as string[]).includes(project.org_id),
            );
        if (filters.in.id)
            return (filters.in.id as string[])
                .filter((id) => shared.includes(id))
                .map((id) => ({ id }));
        return owned.map((id) => ({ id }));
    };

    function auditBuilder() {
        const b: any = {
            select: () => b,
            or: (expr: string) => {
                calls.or = expr;
                return b;
            },
            in: (col: string, val: unknown) => {
                calls.in.push([col, val]);
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
                if (column !== "id") calls.order = [column, options];
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
            if (table === "projects") return filterBuilder(projectsResolver);
            if (table === "project_access_grants")
                return filterBuilder(() =>
                    shared.map((id) => ({ project_id: id })),
                );
            if (table === "org_members")
                return filterBuilder((filters) =>
                    memberships.filter(
                        (membership) =>
                            !filters.eq.org_id ||
                            membership.org_id === filters.eq.org_id,
                    ),
                );
            if (table === "project_org_access_overrides")
                // Two readers: the per-project verdict (eq project_id) and
                // the batched scan keyed by the caller's org memberships
                // (in org_id + eq user_id + eq role).
                return filterBuilder((filters) => {
                    if (filters.eq.project_id)
                        return denied.has(filters.eq.project_id as string)
                            ? [{ role: "deny" }]
                            : [];
                    const orgIds = (filters.in.org_id as string[]) ?? [];
                    return orgProjects
                        .filter(
                            (project) =>
                                denied.has(project.id) &&
                                orgIds.includes(project.org_id),
                        )
                        .map((project) => ({
                            project_id: project.id,
                            role: "deny",
                        }));
                });
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

    it("scopes only to the caller even when projects are owned or shared", async () => {
        const { db, calls } = makeDb(["p-own"], ["p-shared"]);
        await queryEvents(db, "u1", "u1@example.com", query);
        expect(calls.eq).toContainEqual(["user_id", "u1"]);
        expect(calls.in.find(([column]) => column === "project_id")).toBeUndefined();
        expect(calls.or).toBeUndefined();
    });

    it("scopes to own events when no projects are accessible", async () => {
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

    it("looks direct sharing up by normalized email in the grant table", async () => {
        const { db, calls } = makeDb([], ["p-shared"]);
        await listAccessibleProjectIds("u1", " U1@Example.com ", db);
        expect(calls.grantEmail).toBe("u1@example.com");
    });

    it("admits a direct grant holder", async () => {
        const { db } = makeDb([], ["p-granted"]);
        const visible = await listAccessibleProjectIds(
            "u1",
            "u1@example.com",
            db,
        );
        expect(visible).toContain("p-granted");
    });

    // Project access also covers organization membership and detached owners.
    it("admits an organization project the caller does not own", async () => {
        const { db } = makeDb([], [], [], [], {
            memberships: [{ org_id: "o1", role: "member" }],
            projects: [
                { id: "p-colleague", user_id: "u2", org_id: "o1", visibility: "organization" },
                { id: "p-detached", user_id: null, org_id: "o1", visibility: "organization" },
            ],
        });

        const visible = await listAccessibleProjectIds("u1", "u1@example.com", db);

        expect(visible).toEqual(
            expect.arrayContaining(["p-colleague", "p-detached"]),
        );
    });

    // Project-access consumers must respect explicit deny overrides.
    it("excludes an organization project the caller is denied on", async () => {
        const { db } = makeDb([], [], [], [], {
            memberships: [{ org_id: "o1", role: "member" }],
            projects: [
                { id: "p-open", user_id: "u2", org_id: "o1", visibility: "organization" },
                { id: "p-walled", user_id: "u2", org_id: "o1", visibility: "organization" },
            ],
            denies: ["p-walled"],
        });

        const visible = await listAccessibleProjectIds("u1", "u1@example.com", db);

        expect(visible).toContain("p-open");
        expect(visible).not.toContain("p-walled");
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

describe("queryEvents independent of project access", () => {
    it("does not query project access tables for personal activity", async () => {
        const builder: any = {};
        for (const method of ["select", "eq", "order"]) builder[method] = () => builder;
        builder.range = async () => ({ data: [], count: 0, error: null });
        const db: any = { from: (table: string) => {
            if (table !== "audit_events") throw new Error("Project access unavailable");
            return builder;
        } };
        expect(await queryEvents(db, "u1", "u1@example.com", {
            sortBy: "created_at", sortDirection: "desc", page: 1, limit: 50,
        })).toMatchObject({ data: [], count: 0, error: null });
    });
});
