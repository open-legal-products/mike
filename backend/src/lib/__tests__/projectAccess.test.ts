import { describe, expect, it } from "vitest";
import {
    deleteProjectGrant,
    listProjectAdminContacts,
    listProjectGrants,
    listProjectPeople,
    removeGrantsForEmail,
    upsertProjectGrant,
} from "../projectAccess";

type Row = Record<string, unknown>;

// Stateful fake supporting the subset projectAccess.ts uses, including
// `upsert(..., { onConflict })` — the grant table's whole point is that
// re-sharing with a different role is an update, not a conflict.
function makeDb(
    initial: Record<string, Row[]>,
    options: {
        selectErrors?: Record<string, string>;
        deleteErrors?: Record<string, string>;
    } = {},
) {
    const tables: Record<string, Row[]> = {};
    for (const [k, v] of Object.entries(initial)) {
        tables[k] = v.map((r) => ({ ...r }));
    }
    let idCounter = 1;

    function query(table: string) {
        const filters: (
            | { type: "eq"; col: string; val: unknown }
            | { type: "in"; col: string; vals: unknown[] }
        )[] = [];
        let op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
        let payload: Row | Row[] | null = null;
        let conflictCols: string[] = [];

        const ensure = () => (tables[table] ??= []);
        const matches = (rows: Row[]) =>
            rows.filter((r) =>
                filters.every((f) =>
                    f.type === "eq"
                        ? r[f.col] === f.val
                        : f.vals.includes(r[f.col]),
                ),
            );

        function resolveMany(): Promise<{
            data: Row[] | null;
            error: { message: string } | null;
        }> {
            const arr = ensure();
            if (op === "select" && options.selectErrors?.[table]) {
                return Promise.resolve({
                    data: null,
                    error: { message: options.selectErrors[table] },
                });
            }
            if (op === "delete" && options.deleteErrors?.[table]) {
                return Promise.resolve({
                    data: null,
                    error: { message: options.deleteErrors[table] },
                });
            }
            if (op === "insert" || op === "upsert") {
                const rows = Array.isArray(payload)
                    ? payload
                    : [payload as Row];
                const out: Row[] = [];
                for (const r of rows) {
                    const existing =
                        op === "upsert" && conflictCols.length > 0
                            ? arr.find((e) =>
                                  conflictCols.every((c) => e[c] === r[c]),
                              )
                            : undefined;
                    if (existing) {
                        Object.assign(existing, r);
                        out.push(existing);
                    } else {
                        const created = {
                            id: `grant-${idCounter++}`,
                            created_at: `t${idCounter}`,
                            ...r,
                        };
                        arr.push(created);
                        out.push(created);
                    }
                }
                return Promise.resolve({ data: out, error: null });
            }
            const matched = matches(arr);
            if (op === "update") {
                for (const r of matched) Object.assign(r, payload as Row);
                return Promise.resolve({ data: matched, error: null });
            }
            if (op === "delete") {
                tables[table] = arr.filter((r) => !matched.includes(r));
                return Promise.resolve({ data: matched, error: null });
            }
            return Promise.resolve({ data: matched, error: null });
        }

        const builder: Record<string, unknown> = {
            select: () => builder,
            order: () => builder,
            eq: (col: string, val: unknown) => {
                filters.push({ type: "eq", col, val });
                return builder;
            },
            in: (col: string, vals: unknown[]) => {
                filters.push({ type: "in", col, vals });
                return builder;
            },
            insert: (p: Row | Row[]) => {
                op = "insert";
                payload = p;
                return builder;
            },
            upsert: (p: Row | Row[], opts?: { onConflict?: string }) => {
                op = "upsert";
                payload = p;
                conflictCols = (opts?.onConflict ?? "")
                    .split(",")
                    .map((c) => c.trim())
                    .filter(Boolean);
                return builder;
            },
            update: (p: Row) => {
                op = "update";
                payload = p;
                return builder;
            },
            delete: () => {
                op = "delete";
                return builder;
            },
            single: async () => {
                const { data, error } = await resolveMany();
                return { data: data?.[0] ?? null, error };
            },
            maybeSingle: async () => {
                const { data, error } = await resolveMany();
                return { data: data?.[0] ?? null, error };
            },
            then: (
                resolve: (v: {
                    data: Row[] | null;
                    error: { message: string } | null;
                }) => unknown,
                reject?: (e: unknown) => unknown,
            ) => resolveMany().then(resolve, reject),
        };
        return builder;
    }

    return { from: (t: string) => query(t), _tables: tables } as any;
}

const seed = () =>
    makeDb({
        projects: [
            { id: "p1", user_id: "creator", org_id: null },
        ],
        project_access_grants: [],
        user_profiles: [
            { user_id: "creator", email: "creator@firm.example", display_name: "Cee" },
            { user_id: "outside", email: "outside@counsel.example", display_name: "Outside" },
            { user_id: "counsel", email: "counsel@outside.example", display_name: "Counsel" },
            { user_id: "gone", email: "gone@x.example", display_name: "Gone" },
            { user_id: "stays", email: "stays@x.example", display_name: "Stays" },
        ],
        org_members: [],
    });


async function grantsOf(db: unknown, projectId: string) {
    const listed = await listProjectGrants(db as never, projectId);
    if (!listed.ok) throw new Error(listed.detail);
    return listed.grants;
}

describe("project access grants", () => {
    it("creates a grant with the requested role and normalizes the email", async () => {
        const db = seed();
        const result = await upsertProjectGrant(db, {
            projectId: "p1",
            email: "  Outside@Counsel.Example ",
            role: "viewer",
            createdBy: "creator",
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.grant).toMatchObject({
            email: "outside@counsel.example",
            role: "viewer",
        });
    });

    it("re-sharing changes the role instead of conflicting", async () => {
        const db = seed();
        await upsertProjectGrant(db, {
            projectId: "p1",
            email: "counsel@outside.example",
            role: "viewer",
            createdBy: "creator",
        });
        const promoted = await upsertProjectGrant(db, {
            projectId: "p1",
            email: "counsel@outside.example",
            role: "owner",
            createdBy: "creator",
        });
        expect(promoted.ok).toBe(true);
        const grants = await grantsOf(db, "p1");
        expect(grants).toHaveLength(1);
        expect(grants[0].role).toBe("owner");
    });

    it("rejects a malformed address, an unknown role, and the creator", async () => {
        const db = seed();
        await expect(
            upsertProjectGrant(db, {
                projectId: "p1",
                email: "nope",
                role: "viewer",
                createdBy: "creator",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "validation" });
        await expect(
            upsertProjectGrant(db, {
                projectId: "p1",
                email: "x@y.example",
                role: "manager",
                createdBy: "creator",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "validation" });
        await expect(
            upsertProjectGrant(db, {
                projectId: "p1",
                email: "Creator@Firm.example",
                role: "viewer",
                createdBy: "creator",
                creatorEmail: "creator@firm.example",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "validation" });
    });

    it("rejects a grant when the email does not belong to an existing user", async () => {
        const db = seed();
        await expect(
            upsertProjectGrant(db, {
                projectId: "p1",
                email: "future@firm.example",
                role: "viewer",
                createdBy: "creator",
            }),
        ).resolves.toEqual({
            ok: false,
            kind: "validation",
            detail: "future@firm.example does not belong to a Mike user.",
        });
        expect(await grantsOf(db, "p1")).toEqual([]);
    });

    it("reports whether a revoke actually removed anything", async () => {
        const db = seed();
        await expect(
            deleteProjectGrant(db, { projectId: "p1", email: "ghost@x.example" }),
        ).resolves.toMatchObject({ ok: true, removed: false });
    });

    it("revokes every grant addressed to a departing account", async () => {
        const db = seed();
        await upsertProjectGrant(db, {
            projectId: "p1",
            email: "gone@x.example",
            role: "editor",
            createdBy: "creator",
        });
        await upsertProjectGrant(db, {
            projectId: "p1",
            email: "stays@x.example",
            role: "viewer",
            createdBy: "creator",
        });
        await removeGrantsForEmail(db, " Gone@X.example ");
        expect((await grantsOf(db, "p1")).map((g) => g.email)).toEqual([
            "stays@x.example",
        ]);
    });
});

describe("project Owner contacts", () => {
    it("uses only effective organization Owners for an organization project", async () => {
        const db = makeDb({
            projects: [
                {
                    id: "p1",
                    user_id: "creator",
                    org_id: "o1",
                    visibility: "organization",
                },
            ],
            project_access_grants: [
                {
                    id: "g1",
                    project_id: "p1",
                    email: "counsel@outside.example",
                    role: "owner",
                    created_at: "t1",
                },
                {
                    id: "g2",
                    project_id: "p1",
                    email: "reader@outside.example",
                    role: "viewer",
                    created_at: "t2",
                },
            ],
            org_members: [
                { org_id: "o1", user_id: "creator", role: "admin" },
                { org_id: "o1", user_id: "boss", role: "owner" },
                { org_id: "o1", user_id: "staffer", role: "member" },
            ],
            user_profiles: [
                {
                    user_id: "creator",
                    email: "creator@firm.example",
                    display_name: "Cee",
                },
                { user_id: "boss", email: "boss@firm.example", display_name: "Bee" },
            ],
        });

        const contacts = await listProjectAdminContacts(db, {
            id: "p1",
            user_id: "creator",
            org_id: "o1",
            visibility: "organization",
        });
        // The project is public, so the organization's owner is an Owner of
        // it and somebody to ask.
        expect(contacts).toEqual([
            {
                user_id: "creator",
                email: "creator@firm.example",
                display_name: "Cee",
                source: "creator",
            },
            {
                user_id: "boss",
                email: "boss@firm.example",
                display_name: "Bee",
                source: "organization",
            },
        ]);
        // Direct grants are ignored for an organization project. Viewers and
        // plain org Members are not someone to ask for access.
        expect(contacts.map((c) => c.email)).not.toContain(
            "reader@outside.example",
        );
        expect(contacts.map((c) => c.email)).not.toContain(
            "counsel@outside.example",
        );
    });

    it("names only the creator for a private project, not the organization's owners", async () => {
        // The organization's owner has no standing on a member's private
        // matter, so they are not who you ask for access to it.
        const db = makeDb({
            projects: [
                { id: "p1", user_id: "creator", org_id: "o1", visibility: "private" },
            ],
            project_access_grants: [],
            org_members: [
                { org_id: "o1", user_id: "creator", role: "member" },
                { org_id: "o1", user_id: "boss", role: "owner" },
            ],
            user_profiles: [
                {
                    user_id: "creator",
                    email: "creator@firm.example",
                    display_name: "Cee",
                },
                { user_id: "boss", email: "boss@firm.example", display_name: "Bee" },
            ],
        });
        const contacts = await listProjectAdminContacts(db, {
            id: "p1",
            user_id: "creator",
            org_id: "o1",
            visibility: "private",
        });
        expect(contacts.map((contact) => contact.email)).toEqual([
            "creator@firm.example",
        ]);
    });

    it("still names the org's owners when the creator's account is gone", async () => {
        // This is the case an org project is designed to survive: user_id is
        // NULL, and the firm's admins are who you ask.
        const db = makeDb({
            projects: [{ id: "p1", user_id: null, org_id: "o1" }],
            project_access_grants: [],
            org_members: [{ org_id: "o1", user_id: "boss", role: "owner" }],
            user_profiles: [
                { user_id: "boss", email: "boss@firm.example", display_name: "Bee" },
            ],
        });
        const contacts = await listProjectAdminContacts(db, {
            id: "p1",
            user_id: null,
            org_id: "o1",
        });
        expect(contacts).toEqual([
            {
                user_id: "boss",
                email: "boss@firm.example",
                display_name: "Bee",
                source: "organization",
            },
        ]);
    });
});

describe("a failed grants read fails closed", () => {
    const failingRead = () =>
        makeDb(
            {
                project_access_grants: [],
            },
            { selectErrors: { project_access_grants: "connection reset" } },
        );

    it("reports the failure instead of an empty grant list", async () => {
        await expect(listProjectGrants(failingRead(), "p1")).resolves.toEqual({
            ok: false,
            detail: "connection reset",
        });
    });

    it("account deletion refuses to report success over live grants", async () => {
        const db = makeDb(
            {
                project_access_grants: [
                    {
                        id: "g1",
                        project_id: "p1",
                        email: "leaver@firm.example",
                        role: "editor",
                    },
                ],
            },
            { deleteErrors: { project_access_grants: "connection reset" } },
        );
        await expect(
            removeGrantsForEmail(db, "leaver@firm.example"),
        ).rejects.toThrow(/Failed to revoke access grants/);
        // The grant is still there for the retry to find.
        expect(db._tables.project_access_grants).toHaveLength(1);
    });
});


it("carries photos through direct project and inherited content rosters", async () => {
    const { listContentPeople } = await import("../resourcePeople.js");
    const photo = "data:image/png;base64,iVBORw0KGgo=";
    const db = makeDb({
        projects: [{ id: "p1", user_id: "owner", org_id: null }],
        user_profiles: [
            { user_id: "owner", email: "owner@example.com", display_name: "Owner", profile_photo: photo },
            { user_id: "viewer", email: "viewer@example.com", display_name: "Viewer", profile_photo: photo },
        ],
        project_access_grants: [{ id: "g1", project_id: "p1", email: "viewer@example.com", role: "viewer" }],
    });
    const people = await listProjectPeople(db as never, { id: "p1", user_id: "owner" });
    expect(people).toMatchObject({ ok: true, owner: { profile_photo: photo }, members: [{ profile_photo: photo, role: "viewer" }] });
    const inherited = await listContentPeople(db as never, "chat", { id: "chat1", user_id: "owner", project_id: "p1" });
    expect(inherited).toMatchObject({ ok: true, scope: "project", owner: { profile_photo: photo }, members: [{ profile_photo: photo }] });
});
