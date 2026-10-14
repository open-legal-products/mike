import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    AUDIT_EXPORT_LIMIT,
    buildAuditCsv,
    parseQuery,
    queryEvents,
} from "../auditExport";

const access = vi.hoisted(() => ({ role: "admin" as string | null }));
vi.mock("../access", () => ({
    getOrgRole: vi.fn(async () => access.role),
    isOrgAdmin: (role: string) => role === "admin" || role === "owner",
    listAccessibleProjectIds: vi.fn(async () => ["visible-project"]),
}));

const orgId = "00000000-0000-4000-8000-000000000010";
const eventId = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const parsed = parseQuery({}, AUDIT_EXPORT_LIMIT);
const query = parsed.ok ? parsed.query : (undefined as never);
type Row = Record<string, unknown>;

// Apply scope and id predicates before pagination, as PostgREST does. A low
// response cap checks that matching events and selected events are all read.
function database(
    events: Row[],
    profiles: Row[] = [],
    maxRows = 1000,
    profileError = false,
) {
    const calls: unknown[][] = [];
    function builder(table: string) {
        calls.push(["read", table]);
        let rows = [...(table === "user_profiles" ? profiles : events)];
        let filterIdCount = 0;
        const orders: { column: string; ascending: boolean }[] = [];
        const q = {
            select(columns: string) {
                calls.push([table, "select", columns]);
                return q;
            },
            eq(column: string, value: unknown) {
                rows = rows.filter((row) => row[column] === value);
                return q;
            },
            in(column: string, values: unknown[]) {
                filterIdCount += values.length;
                calls.push([table, "in", column, values]);
                rows = rows.filter((row) => values.includes(row[column]));
                return q;
            },
            or() {
                rows = rows.filter((row) => row.user_id !== "actor");
                return q;
            },
            ilike(column: string, pattern: string) {
                calls.push([table, "ilike", column, pattern]);
                const literal = pattern
                    .slice(1, -1)
                    .replace(/\\([\\%_])/g, "$1")
                    .toLowerCase();
                rows = rows.filter((row) =>
                    String(row[column] ?? "")
                        .toLowerCase()
                        .includes(literal),
                );
                return q;
            },
            username(pattern: string) {
                const literal = pattern.slice(1, -1).replace(/\\([\\%_])/g, "$1").toLowerCase();
                rows = rows.filter((row) => {
                    const profile = profiles.find((p) => p.user_id === row.user_id);
                    return [row.user_email, profile?.display_name, profile?.email]
                        .some((value) => String(value ?? "").toLowerCase().includes(literal));
                });
                return q;
            },
            order(column: string, options?: { ascending: boolean }) {
                orders.push({ column, ascending: options?.ascending ?? true });
                return q;
            },
            range(from: number, to: number) {
                calls.push([table, "filter-id-count", filterIdCount]);
                calls.push([table, "range", from, to]);
                const sorted = [...rows].sort((a, b) => {
                    for (const { column, ascending } of orders) {
                        if (a[column] === b[column]) continue;
                        return (
                            (String(a[column]) < String(b[column]) ? -1 : 1) *
                            (ascending ? 1 : -1)
                        );
                    }
                    return 0;
                });
                return Promise.resolve(
                    profileError && table === "user_profiles"
                        ? {
                              data: null,
                              error: { message: "profile unavailable" },
                              count: null,
                          }
                        : {
                              data: sorted.slice(
                                  from,
                                  Math.min(to + 1, from + maxRows),
                              ),
                              error: null,
                              count: rows.length,
                          },
                );
            },
            then(resolve: (result: unknown) => unknown) {
                return Promise.resolve(profileError && table === "user_profiles"
                    ? { data: null, error: { message: "profile unavailable" } }
                    : { data: rows, error: null }).then(resolve);
            },
        };
        return q;
    }
    return {
        db: {
            from: builder,
            rpc: async (name: string, args: {
                p_org_id: string; p_filter: Record<string, unknown>;
                p_sort_by: string; p_sort_direction: string; p_offset: number; p_limit: number;
            }) => {
                calls.push(["rpc", name, args]);
                const q = builder(name).eq("org_id", args.p_org_id);
                const filter = args.p_filter;
                if (filter.username_pattern) {
                    if (profileError) return { data: null, error: { message: "profile unavailable" } };
                    q.username(String(filter.username_pattern));
                }
                for (const key of ["action", "status", "surface"]) {
                    if (filter[key]) q.eq(key, filter[key]);
                }
                if (filter.actor_user_id) q.eq("user_id", filter.actor_user_id);
                if (filter.title_pattern) q.ilike("title", String(filter.title_pattern));
                if (filter.event_ids) q.in("id", filter.event_ids as string[]);
                if (filter.user_ids) q.in("user_id", filter.user_ids as string[]);
                const result = await q.order(args.p_sort_by, { ascending: args.p_sort_direction === "asc" })
                    .order("id", { ascending: true }).range(args.p_offset, args.p_offset + args.p_limit - 1);
                return { data: { events: result.data, total: result.count }, error: result.error };
            },
        } as never,
        calls,
    };
}

beforeEach(() => {
    access.role = "admin";
});

describe("audit selection and username validation", () => {
    it("trims the username and normalizes duplicate selected ids", () => {
        expect(
            parseQuery(
                {
                    org_id: orgId,
                    username: "  Alex  ",
                    event_ids: [eventId(1), eventId(1)],
                },
                50,
            ),
        ).toMatchObject({
            ok: true,
            query: { orgId, userName: "Alex", eventIds: [eventId(1)] },
        });
    });

    it("rejects malformed, empty, or oversized selections instead of exporting all rows", () => {
        for (const event_ids of [
            null,
            "all",
            [],
            ["invalid"],
            [null],
            Array(2001).fill(eventId(1)),
        ]) {
            expect(parseQuery({ event_ids }, AUDIT_EXPORT_LIMIT)).toMatchObject(
                { ok: false },
            );
        }
        expect(
            parseQuery(
                {
                    event_ids: Array.from({ length: 2000 }, (_, i) =>
                        eventId(i),
                    ),
                },
                AUDIT_EXPORT_LIMIT,
            ),
        ).toMatchObject({ ok: true });
    });

    it("rejects username filtering without an organization or with non-text input", () => {
        expect(parseQuery({ username: "Alex" }, 50)).toMatchObject({
            ok: false,
        });
        expect(
            parseQuery({ org_id: orgId, username: ["Alex"] }, 50),
        ).toMatchObject({ ok: false });
    });
});

describe("personal activity", () => {
    it("lists and exports only the caller's actions across personal and organization projects", async () => {
        const events = [
            { id: eventId(1), user_id: "actor", title: "Own personal action" },
            { id: eventId(2), user_id: "actor", project_id: "visible-project", title: "Own shared-project action" },
            { id: eventId(3), user_id: "actor", org_id: orgId, title: "Own organization action" },
            { id: eventId(4), user_id: "colleague", project_id: "visible-project", title: "Colleague action" },
            { id: eventId(5), user_id: null, project_id: "visible-project", title: "Unattributed action" },
        ];
        const { db, calls } = database(events);
        const out = await queryEvents(db, "actor", undefined, { ...query, limit: 2 }, false);
        expect(out.count).toBe(3);
        expect(out.data?.map((row) => row.id)).toEqual([eventId(1), eventId(2)]);
        const next = await queryEvents(db, "actor", undefined, { ...query, page: 2, limit: 2 }, false);
        expect(next.count).toBe(3);
        expect(next.data?.map((row) => row.id)).toEqual([eventId(3)]);
        const csv = await buildAuditCsv(db, "actor", undefined, query);
        expect(csv.split("\n")).toHaveLength(4);
        expect(csv).toContain("Own personal action");
        expect(csv).toContain("Own shared-project action");
        expect(csv).toContain("Own organization action");
        expect(csv).not.toContain("Colleague action");
        expect(csv).not.toContain("Unattributed action");
        expect(calls.filter((call) => call[0] === "read").every((call) => call[1] === "audit_events")).toBe(true);
    });
});

describe("selected audit exports", () => {
    it("exports only the caller's selected events, even in shared projects", async () => {
        const { db } = database([
            { id: eventId(1), user_id: "actor", title: "Own" },
            {
                id: eventId(2),
                user_id: "colleague",
                project_id: "visible-project",
                title: "Shared",
            },
            {
                id: eventId(3),
                user_id: "colleague",
                project_id: "private-project",
                title: "Private",
            },
            { id: eventId(4), user_id: "actor", title: "Unselected" },
        ]);
        const csv = await buildAuditCsv(db, "actor", undefined, {
            ...query,
            eventIds: [eventId(1), eventId(2), eventId(3)],
        });
        expect(csv.split("\n")).toHaveLength(2);
        expect(csv).toContain("Own");
        expect(csv).not.toContain("Shared");
        expect(csv).not.toContain("Private");
        expect(csv).not.toContain("Unselected");
    });

    it("batches large selections and merges them in the requested order", async () => {
        const events = Array.from({ length: 251 }, (_, i) => ({
            id: eventId(i),
            user_id: "actor",
            title: String(i).padStart(3, "0"),
        }));
        const { db, calls } = database(events, [], 30);
        const out = await queryEvents(
            db,
            "actor",
            undefined,
            {
                ...query,
                eventIds: events.slice(0, 250).map((event) => event.id),
                sortBy: "title",
                sortDirection: "desc",
            },
            false,
        );
        expect(out.count).toBe(250);
        expect(out.data?.map((row) => row.id)).toEqual(
            events
                .slice(0, 250)
                .reverse()
                .map((event) => event.id),
        );
        expect(
            calls
                .filter((call) => call[1] === "in" && call[2] === "id")
                .every((call) => (call[3] as string[]).length <= 200),
        ).toBe(true);
        expect(
            calls
                .filter((call) => call[1] === "filter-id-count")
                .every((call) => Number(call[2]) <= 200),
        ).toBe(true);
    });
});

describe("organization username filtering", () => {
    it("matches either name or email without duplicating actors or crossing organizations", async () => {
        const { db } = database([
            { id: eventId(1), org_id: orgId, user_id: "both" },
            { id: eventId(2), org_id: orgId, user_id: "email-only" },
            { id: eventId(3), org_id: "other-org", user_id: "email-only" },
        ], [
            { user_id: "both", display_name: "Alex", email: "alex@example.com" },
            { user_id: "email-only", display_name: "Jane", email: "jane.alex@example.com" },
        ]);
        const result = await queryEvents(db, "actor", undefined, { ...query, orgId, userName: "aLeX" }, false);
        expect(result.data?.map((row) => row.id)).toEqual([eventId(1), eventId(2)]);
        expect(result.count).toBe(2);
    });

    it("continues to include other actors in the requested organization's log", async () => {
        const { db } = database([
            { id: eventId(1), org_id: orgId, user_id: "actor" },
            { id: eventId(2), org_id: orgId, user_id: "colleague" },
            { id: eventId(3), org_id: "other-org", user_id: "colleague" },
        ]);
        const out = await queryEvents(db, "actor", undefined, { ...query, orgId }, false);
        expect(out.count).toBe(2);
        expect(out.data?.map((row) => row.id)).toEqual([eventId(1), eventId(2)]);
    });
    it("matches names case-insensitively, includes former members, and preserves org scope in CSV", async () => {
        const { db } = database(
            [
                {
                    id: eventId(1),
                    org_id: orgId,
                    user_id: "former-member",
                    title: "Matched",
                },
                {
                    id: eventId(2),
                    org_id: orgId,
                    user_id: "pat",
                    title: "Different user",
                },
                {
                    id: eventId(3),
                    org_id: "other-org",
                    user_id: "former-member",
                    title: "Other org",
                },
            ],
            [
                { user_id: "former-member", display_name: "Alex Lawyer" },
                { user_id: "pat", display_name: "Pat" },
            ],
        );
        const csv = await buildAuditCsv(db, "actor", undefined, {
            ...query,
            orgId,
            userName: "aLeX",
            eventIds: [eventId(1), eventId(2), eventId(3)],
        });
        expect(csv.split("\n")).toHaveLength(2);
        expect(csv).toContain("Matched");
        expect(csv).not.toContain("Different user");
        expect(csv).not.toContain("Other org");
    });

    it("pages matching org events without fetching or partitioning platform-wide profiles", async () => {
        const profiles = Array.from({ length: 205 }, (_, i) => ({
            user_id: `user-${i}`,
            display_name: "Alex",
        }));
        const events = profiles.map((profile, i) => ({
            id: eventId(i),
            org_id: orgId,
            user_id: profile.user_id,
        }));
        const { db, calls } = database(events, profiles, 50);
        const out = await queryEvents(
            db,
            "actor",
            undefined,
            {
                ...query,
                orgId,
                userName: "Alex",
                eventIds: events.map((event) => event.id),
                sortBy: "title",
                sortDirection: "asc",
            },
            false,
        );
        expect(out.count).toBe(205);
        expect(out.data?.map((row) => row.id)).toEqual(
            events.map((row) => row.id),
        );
        expect(calls).not.toContainEqual(["read", "user_profiles"]);
        expect(calls.filter((call) => call[0] === "rpc")).toHaveLength(5);
        expect(calls.filter((call) => call[0] === "rpc").map((call) =>
            (call[2] as { p_offset: number }).p_offset)).toEqual([0, 50, 100, 150, 200]);
    });

    it("escapes wildcard characters and returns an empty result for no match", async () => {
        const { db, calls } = database(
            [],
            [{ user_id: "someone", display_name: "Alex" }],
        );
        expect(
            await queryEvents(db, "actor", undefined, {
                ...query,
                orgId,
                userName: "A%_",
            }),
        ).toMatchObject({ data: [], count: 0, error: null });
        expect(calls).not.toContainEqual(["read", "user_profiles"]);
        expect(calls).toContainEqual(["rpc", "organization_audit_events_page", expect.objectContaining({
            p_filter: expect.objectContaining({ username_pattern: "%A\\%\\_%" }),
        })]);
    });

    it("fails closed when the profile lookup fails", async () => {
        const { db } = database([], [], 1000, true);
        await expect(
            buildAuditCsv(db, "actor", undefined, {
                ...query,
                orgId,
                userName: "Alex",
            }),
        ).rejects.toThrow("profile unavailable");
    });

    it.each(["member", null])(
        "checks access before looking up usernames for role %s",
        async (role) => {
            access.role = role;
            const { db, calls } = database([]);
            await expect(
                buildAuditCsv(db, "actor", undefined, {
                    ...query,
                    orgId,
                    userName: "Alex",
                    eventIds: [eventId(1)],
                }),
            ).rejects.toThrow("access denied");
            expect(calls).toEqual([]);
        },
    );
});


describe("audit actor photos", () => {
    const photo = "data:image/png;base64,cGhvdG8=";
    const events = [
        { id: eventId(1), org_id: orgId, user_id: "actor", created_at: "2026-10-14", title: "Latest" },
        { id: eventId(2), org_id: orgId, user_id: "colleague", created_at: "2026-10-13", title: "Older" },
    ];
    const profiles = [
        { user_id: "actor", display_name: "Alex Morgan", profile_photo: photo },
        { user_id: "colleague", display_name: "Jamie", profile_photo: "other-photo" },
        { user_id: "stranger", display_name: "Unrelated", profile_photo: "private-photo" },
    ];

    it("resolves photos only for actors on the authorized organization page", async () => {
        const { db, calls } = database(events, profiles);
        const result = await queryEvents(db, "actor", undefined, { ...query, orgId, limit: 1 });
        expect(result.data).toEqual([
            expect.objectContaining({ title: "Latest", user_display_name: "Alex Morgan", user_profile_photo: photo }),
        ]);
        expect(calls.filter(([table, operation]) => table === "user_profiles" && operation === "in"))
            .toEqual([["user_profiles", "in", "user_id", ["actor"]]]);
        expect(calls).toContainEqual(["user_profiles", "select", "user_id, display_name, profile_photo"]);
    });

    it("does not request photos for personal activity or profile data for CSV exports", async () => {
        const personal = database(events, profiles);
        const result = await queryEvents(personal.db, "actor", undefined, query);
        expect(personal.calls).toContainEqual(["user_profiles", "select", "user_id, display_name"]);
        expect(result.data?.[0]).not.toHaveProperty("user_profile_photo");
        const csv = database(events, profiles);
        expect(await buildAuditCsv(csv.db, "actor", undefined, { ...query, orgId })).not.toContain(photo);
        expect(csv.calls).not.toContainEqual(["read", "user_profiles"]);
    });

    it("does not resolve profiles when organization access is denied", async () => {
        access.role = "member";
        const { db, calls } = database(events, profiles);
        const result = await queryEvents(db, "actor", undefined, { ...query, orgId });
        expect(result.error).toEqual({ message: "Organization audit access denied" });
        expect(calls).toEqual([]);
    });

    it("keeps events readable with monogram fallbacks when profiles are unavailable", async () => {
        const { db } = database(events, profiles, 1000, true);
        const result = await queryEvents(db, "actor", undefined, { ...query, orgId });
        expect(result.error).toBeNull();
        expect(result.data).toHaveLength(2);
        expect(result.data?.[0]).toMatchObject({ title: "Latest", user_display_name: null, user_profile_photo: null });
    });
});

describe("affected audit identities", () => {
    const events = [
        { id: eventId(1), org_id: orgId, user_id: "actor", created_at: "2026-10-14", action: "org.member.role_changed", title: "old@example.com", detail: { target_user_id: "member" } },
        { id: eventId(2), org_id: orgId, user_id: "actor", created_at: "2026-10-13", action: "org.invite.created", title: "INVITEE@example.com", detail: {} },
        { id: eventId(3), org_id: orgId, user_id: "actor", created_at: "2026-10-12", action: "document.edited", title: "stranger@example.com", detail: { target_user_id: "stranger" } },
    ];
    const profiles = [
        { user_id: "actor", email: "actor@example.com", display_name: "Alex" },
        { user_id: "member", email: "new@example.com", display_name: " Jamie Morgan ", profile_photo: "private-photo" },
        { user_id: "invitee", email: "invitee@example.com", display_name: "Taylor Smith" },
        { user_id: "stranger", email: "stranger@example.com", display_name: "Unrelated" },
    ];

    it("resolves member IDs and invitation emails without changing recorded titles or fetching affected photos", async () => {
        const { db, calls } = database(events, profiles);
        const result = await queryEvents(db, "actor", undefined, { ...query, orgId });
        expect(result.data?.[0]).toMatchObject({ title: "old@example.com", affected_user_display_name: "Jamie Morgan" });
        expect(result.data?.[1]).toMatchObject({ title: "INVITEE@example.com", affected_user_display_name: "Taylor Smith" });
        expect(result.data?.[2]).not.toHaveProperty("affected_user_display_name");
        expect(calls.filter(([table, operation]) => table === "user_profiles" && operation === "in"))
            .toEqual([
                ["user_profiles", "in", "user_id", ["actor"]],
                ["user_profiles", "in", "user_id", ["member"]],
                ["user_profiles", "in", "email", ["invitee@example.com"]],
            ]);
        expect(calls.filter(([table, operation]) => table === "user_profiles" && operation === "select"))
            .toEqual([
                ["user_profiles", "select", "user_id, display_name, profile_photo"],
                ["user_profiles", "select", "user_id, email, display_name"],
                ["user_profiles", "select", "user_id, email, display_name"],
            ]);
        expect(JSON.stringify(result.data)).not.toContain("private-photo");
    });

    it("only resolves affected identities on the final authorized page, including personal activity", async () => {
        const { db, calls } = database(events, profiles);
        const result = await queryEvents(db, "actor", undefined, { ...query, limit: 1 });
        expect(result.data?.[0].affected_user_display_name).toBe("Jamie Morgan");
        expect(calls.filter(([table, operation]) => table === "user_profiles" && operation === "in"))
            .toEqual([
                ["user_profiles", "in", "user_id", ["actor"]],
                ["user_profiles", "in", "user_id", ["member"]],
            ]);
    });

    it("keeps email fallbacks when names are missing or the profile read fails", async () => {
        for (const profileError of [false, true]) {
            const { db } = database(events, [{ ...profiles[1], display_name: " " }], 1000, profileError);
            const result = await queryEvents(db, "actor", undefined, { ...query, orgId });
            expect(result.error).toBeNull();
            expect(result.data?.[0]).toMatchObject({ title: "old@example.com" });
            expect(result.data?.[0]).not.toHaveProperty("affected_user_display_name");
        }
    });

    it("never falls back to an email's new owner when the recorded member ID is missing", async () => {
        const { db, calls } = database([events[0]], [{ user_id: "other", email: "old@example.com", display_name: "Wrong person" }]);
        const result = await queryEvents(db, "actor", undefined, { ...query, orgId });
        expect(result.data?.[0]).not.toHaveProperty("affected_user_display_name");
        expect(calls.some((call) => call[0] === "user_profiles" && call[1] === "in" && call[2] === "email")).toBe(false);
    });

    it("skips affected profile lookups for CSV and denied organization access", async () => {
        const csv = database(events, profiles);
        expect(await buildAuditCsv(csv.db, "actor", undefined, { ...query, orgId })).toContain("old@example.com");
        expect(csv.calls).not.toContainEqual(["read", "user_profiles"]);
        access.role = "member";
        const denied = database(events, profiles);
        expect((await queryEvents(denied.db, "actor", undefined, { ...query, orgId })).error).not.toBeNull();
        expect(denied.calls).toEqual([]);
    });
});


describe("exact actor filtering", () => {
    it("validates IDs and disallows narrowing personal activity to another person", () => {
        expect(parseQuery({ actor_user_id: eventId(1) }, 50).ok).toBe(false);
        expect(parseQuery({ org_id: orgId, actor_user_id: "bad" }, 50).ok).toBe(false);
        expect(parseQuery({ org_id: orgId, actor_user_id: eventId(1) }, 50)).toMatchObject({ ok: true, query: { actorUserId: eventId(1) } });
    });
    it("matches only the selected ID even when two people share a name, including exports", async () => {
        const { db } = database([
            { id: eventId(1), org_id: orgId, user_id: eventId(11), user_email: "one@example.com", title: "First", created_at: "2026-10-14" },
            { id: eventId(2), org_id: orgId, user_id: eventId(12), user_email: "two@example.com", title: "Second", created_at: "2026-10-14" },
        ], [
            { user_id: eventId(11), display_name: "Alex" },
            { user_id: eventId(12), display_name: "Alex" },
        ]);
        const selected = { ...query, orgId, actorUserId: eventId(11) };
        expect((await queryEvents(db, "actor", undefined, selected)).data?.map((row) => row.id)).toEqual([eventId(1)]);
        const csv = await buildAuditCsv(db, "actor", undefined, selected);
        expect(csv).toContain("one@example.com");
        expect(csv).not.toContain("two@example.com");
    });
});
