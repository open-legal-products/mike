import { describe, expect, it } from "vitest";
import {
    acceptInvitation,
    cancelInvitation,
    createInvitation,
    createOrg,
    declineInvitation,
    getOrg,
    listInvitations,
    listMembers,
    listMyInvitations,
    listMyOrgs,
    listOrgResources,
    removeMember,
    resendInvitation,
    updateMember,
} from "../orgs";

type Row = Record<string, unknown>;

// Stateful in-memory Supabase fake: unlike the read-only makeDb in
// access.test.ts, this one actually mutates the seeded tables so
// insert/update/delete round-trips (membership changes, last-admin counts) can
// be asserted. Supports the subset of the query builder the service uses.
function makeDb(initial: Record<string, Row[]>) {
    const tables: Record<string, Row[]> = {};
    for (const [k, v] of Object.entries(initial)) tables[k] = v.map((r) => ({ ...r }));
    const selects: Record<string, string[]> = {};
    let idCounter = 1;

    function query(table: string) {
        const filters: (
            | { type: "eq"; col: string; val: unknown }
            | { type: "in"; col: string; vals: unknown[] }
        )[] = [];
        let op: "select" | "insert" | "update" | "delete" = "select";
        let payload: Row | Row[] | null = null;
        let orderCol: string | null = null;
        let orderAsc = true;
        let limitN: number | null = null;

        const ensure = () => (tables[table] ??= []);
        const matches = (rows: Row[]) =>
            rows.filter((r) =>
                filters.every((f) =>
                    f.type === "eq"
                        ? r[f.col] === f.val
                        : f.vals.includes(r[f.col]),
                ),
            );

        function resolveMany(): Promise<{ data: Row[]; error: null }> {
            const arr = ensure();
            if (op === "insert") {
                const rows = Array.isArray(payload) ? payload : [payload as Row];
                const inserted = rows.map((r) => ({ id: `row-${idCounter++}`, ...r }));
                arr.push(...inserted);
                return Promise.resolve({ data: inserted, error: null });
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
            let out = [...matched];
            if (orderCol) {
                const col = orderCol;
                out.sort((a, b) =>
                    ((a[col] as number) > (b[col] as number) ? 1 : -1) *
                    (orderAsc ? 1 : -1),
                );
            }
            if (limitN != null) out = out.slice(0, limitN);
            return Promise.resolve({ data: out, error: null });
        }

        async function resolveSingle() {
            const { data } = await resolveMany();
            return { data: data[0] ?? null, error: null };
        }

        const builder: Record<string, unknown> = {
            select: (columns = "*") => {
                (selects[table] ??= []).push(columns);
                return builder;
            },
            eq: (col: string, val: unknown) => {
                filters.push({ type: "eq", col, val });
                return builder;
            },
            in: (col: string, vals: unknown[]) => {
                filters.push({ type: "in", col, vals });
                return builder;
            },
            order: (col: string, opts?: { ascending?: boolean }) => {
                orderCol = col;
                orderAsc = opts?.ascending !== false;
                return builder;
            },
            limit: (n: number) => {
                limitN = n;
                return builder;
            },
            insert: (p: Row | Row[]) => {
                op = "insert";
                payload = p;
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
            single: () => resolveSingle(),
            maybeSingle: () => resolveSingle(),
            then: (
                resolve: (v: { data: Row[]; error: null }) => unknown,
                reject?: (e: unknown) => unknown,
            ) => resolveMany().then(resolve, reject),
        };
        return builder;
    }

    return {
        from: (t: string) => query(t),
        _tables: tables,
        _selects: selects,
    } as any;
}



// ---------------------------------------------------------------------------
// Roles: admin / member only
// ---------------------------------------------------------------------------

describe("orgs.service roles", () => {
    it("createOrg makes the creator an admin", async () => {
        const db = makeDb({});
        const result = await createOrg(db, { userId: "u1", name: "Acme" });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.org.role).toBe("admin");
        const members = db._tables.org_members as Row[];
        expect(members).toHaveLength(1);
        expect(members[0]).toMatchObject({ user_id: "u1", role: "admin" });
    });

    it("rejects a blank org name", async () => {
        const db = makeDb({});
        const result = await createOrg(db, { userId: "u1", name: "  " });
        expect(result).toMatchObject({ ok: false, kind: "validation" });
    });

    it("has no owner role left to grant", async () => {
        const db = makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "admin1", role: "admin" },
                { id: "m2", org_id: "o1", user_id: "member1", role: "member" },
            ],
        });
        const result = await updateMember(db, {
            actorId: "admin1",
            orgId: "o1",
            targetUserId: "member1",
            role: "owner",
        });
        expect(result).toMatchObject({ ok: false, kind: "validation" });
    });

    const seedPair = () =>
        makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "admin1", role: "admin" },
                { id: "m2", org_id: "o1", user_id: "member1", role: "member" },
            ],
        });

    it("lets an admin promote a member", async () => {
        const db = seedPair();
        await expect(
            updateMember(db, {
                actorId: "admin1",
                orgId: "o1",
                targetUserId: "member1",
                role: "admin",
            }),
        ).resolves.toMatchObject({ ok: true });
    });

    it("audits role changes and removals like the invitation lifecycle", async () => {
        // An org role inherits onto every project the org owns, so changing
        // or removing one moves real standing — it belongs in the same audit
        // trail org.invite.* already writes to.
        const db = seedPair();
        (db._tables.user_profiles ??= []).push({
            user_id: "member1",
            email: "member1@example.com",
        });
        await expect(
            updateMember(db, {
                actorId: "admin1",
                actorEmail: "admin1@example.com",
                orgId: "o1",
                targetUserId: "member1",
                role: "admin",
            }),
        ).resolves.toMatchObject({ ok: true });
        await expect(
            removeMember(db, {
                actorId: "admin1",
                actorEmail: "admin1@example.com",
                orgId: "o1",
                targetUserId: "member1",
            }),
        ).resolves.toMatchObject({ ok: true });

        const events = (db._tables.audit_events ?? []) as Record<
            string,
            unknown
        >[];
        expect(events.map((e) => e.action)).toEqual([
            "org.member.role_changed",
            "org.member.removed",
        ]);
        expect(events[0]).toMatchObject({
            user_id: "admin1",
            user_email: "admin1@example.com",
            title: "member1@example.com",
            detail: {
                org_id: "o1",
                target_user_id: "member1",
                previous_role: "member",
                role: "admin",
            },
        });
        expect(events[1].detail).toMatchObject({ role: "admin" });
    });

    it("audits a self-removal as leaving, not as being removed", async () => {
        const db = makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "admin1", role: "admin" },
                { id: "m2", org_id: "o1", user_id: "member1", role: "member" },
            ],
        });
        await expect(
            removeMember(db, {
                actorId: "member1",
                actorEmail: "member1@example.com",
                orgId: "o1",
                targetUserId: "member1",
            }),
        ).resolves.toMatchObject({ ok: true });
        const events = (db._tables.audit_events ?? []) as Record<
            string,
            unknown
        >[];
        expect(events.map((e) => e.action)).toEqual(["org.member.left"]);
    });

    it("lets a member change nobody's role, including their own", async () => {
        const db = seedPair();
        await expect(
            updateMember(db, {
                actorId: "member1",
                orgId: "o1",
                targetUserId: "admin1",
                role: "member",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "forbidden" });
        await expect(
            updateMember(db, {
                actorId: "member1",
                orgId: "o1",
                targetUserId: "member1",
                role: "admin",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "forbidden" });
    });

    it("hides an org entirely from non-members (404, not 403)", async () => {
        const db = makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "admin1", role: "admin" },
            ],
        });
        await expect(
            getOrg(db, { userId: "stranger", orgId: "o1" }),
        ).resolves.toMatchObject({ ok: false, kind: "not_found" });
        await expect(
            listMembers(db, { userId: "stranger", orgId: "o1" }),
        ).resolves.toMatchObject({ ok: false, kind: "not_found" });
    });

    it("reports each membership's role and roster size", async () => {
        const db = makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "admin1", role: "admin" },
                { id: "m2", org_id: "o1", user_id: "member1", role: "member" },
            ],
        });
        const result = await listMyOrgs(db, "member1");
        expect(result).toMatchObject({ ok: true });
        if (!result.ok) return;
        expect(result.orgs[0]).toMatchObject({
            id: "o1",
            role: "member",
            member_count: 2,
        });
    });
});

describe("organization resources", () => {
    it("queries workflow columns that exist in the workflows schema", async () => {
        const db = makeDb({
            org_members: [
                { org_id: "o1", user_id: "member1", role: "member" },
            ],
            projects: [],
            workflows: [
                {
                    id: "workflow1",
                    user_id: "member1",
                    org_id: "o1",
                    title: "Disclosure workflow",
                    type: "tabular",
                    practice: "Corporate",
                    created_at: "2026-09-01T00:00:00Z",
                },
            ],
        });

        await expect(
            listOrgResources(db, { userId: "member1", orgId: "o1" }),
        ).resolves.toMatchObject({
            ok: true,
            workflows: [{ id: "workflow1" }],
        });
        expect(db._selects.workflows).toEqual([
            "id, user_id, org_id, title, type, practice, created_at",
        ]);
    });

    // A `deny` override is the ethical wall. The columns this endpoint serves
    // — a project's name and cm_number, a workflow's title — are exactly what
    // a wall exists to withhold, so listing the row and letting the link 404
    // would leak the thing the override was bought to hide.
    it("hides denied projects and workflows from the member who is denied", async () => {
        const db = makeDb({
            org_members: [
                { org_id: "o1", user_id: "member1", role: "member" },
                { org_id: "o1", user_id: "member2", role: "member" },
            ],
            projects: [
                { id: "walled", user_id: "member2", org_id: "o1", name: "Project Nimbus", cm_number: "1234-5678" },
                { id: "open", user_id: "member2", org_id: "o1", name: "Shared matter" },
            ],
            workflows: [
                { id: "walled-wf", user_id: "member2", org_id: "o1", title: "Nimbus diligence" },
                { id: "open-wf", user_id: "member2", org_id: "o1", title: "Standard diligence" },
            ],
            project_org_access_overrides: [
                { project_id: "walled", org_id: "o1", user_id: "member1", role: "deny" },
            ],
            workflow_org_access_overrides: [
                { workflow_id: "walled-wf", org_id: "o1", user_id: "member1", role: "deny" },
            ],
        });

        const denied = await listOrgResources(db, {
            userId: "member1",
            orgId: "o1",
        });
        expect(denied).toMatchObject({ ok: true });
        if (!denied.ok) return;
        expect(denied.projects).toEqual([expect.objectContaining({ id: "open" })]);
        expect(denied.workflows).toEqual([
            expect.objectContaining({ id: "open-wf" }),
        ]);
        // The name and matter number must not travel either.
        expect(JSON.stringify(denied)).not.toContain("Nimbus");
        expect(JSON.stringify(denied)).not.toContain("1234-5678");

        // Everyone else still sees both.
        const other = await listOrgResources(db, {
            userId: "member2",
            orgId: "o1",
        });
        expect(other).toMatchObject({ ok: true });
        if (!other.ok) return;
        expect(other.projects).toHaveLength(2);
        expect(other.workflows).toHaveLength(2);
    });

    // Mirrors project_access_role: a denial cannot bind an admin or the
    // resource's creator, and validate_org_access_override refuses to write
    // one. A stale row must not hide the resource from them.
    it("ignores a stale denial against an admin or the creator", async () => {
        const db = makeDb({
            org_members: [
                { org_id: "o1", user_id: "admin1", role: "admin" },
                { org_id: "o1", user_id: "creator1", role: "member" },
            ],
            projects: [
                { id: "p1", user_id: "creator1", org_id: "o1", name: "Matter" },
            ],
            workflows: [],
            project_org_access_overrides: [
                { project_id: "p1", org_id: "o1", user_id: "admin1", role: "deny" },
                { project_id: "p1", org_id: "o1", user_id: "creator1", role: "deny" },
            ],
            workflow_org_access_overrides: [],
        });

        for (const userId of ["admin1", "creator1"]) {
            const result = await listOrgResources(db, { userId, orgId: "o1" });
            expect(result).toMatchObject({ ok: true });
            if (!result.ok) return;
            expect(result.projects).toEqual([
                expect.objectContaining({ id: "p1" }),
            ]);
        }
    });

    it("scopes the denial lookup to the caller, not to the whole org", async () => {
        const db = makeDb({
            org_members: [
                { org_id: "o1", user_id: "member1", role: "member" },
                { org_id: "o1", user_id: "member2", role: "member" },
            ],
            projects: [
                { id: "p1", user_id: "someone", org_id: "o1", name: "Matter" },
            ],
            workflows: [],
            // member2 is walled off; member1 is not.
            project_org_access_overrides: [
                { project_id: "p1", org_id: "o1", user_id: "member2", role: "deny" },
            ],
            workflow_org_access_overrides: [],
        });

        const visible = await listOrgResources(db, {
            userId: "member1",
            orgId: "o1",
        });
        expect(visible).toMatchObject({
            ok: true,
            projects: [expect.objectContaining({ id: "p1" })],
        });
    });
});

// ---------------------------------------------------------------------------
// The database-backed "at least one admin" rule, at the service layer
// ---------------------------------------------------------------------------

describe("last-admin protection", () => {
    const seedSoleAdmin = () =>
        makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "admin1", role: "admin" },
                { id: "m2", org_id: "o1", user_id: "member1", role: "member" },
            ],
        });

    it("refuses to demote the last admin", async () => {
        const db = seedSoleAdmin();
        await expect(
            updateMember(db, {
                actorId: "admin1",
                orgId: "o1",
                targetUserId: "admin1",
                role: "member",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "last_admin" });
    });

    it("refuses to remove the last admin, even by their own hand", async () => {
        const db = seedSoleAdmin();
        await expect(
            removeMember(db, {
                actorId: "admin1",
                orgId: "o1",
                targetUserId: "admin1",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "last_admin" });
    });

    it("allows both once a second admin exists", async () => {
        const db = makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "admin1", role: "admin" },
                { id: "m2", org_id: "o1", user_id: "admin2", role: "admin" },
            ],
        });
        await expect(
            updateMember(db, {
                actorId: "admin1",
                orgId: "o1",
                targetUserId: "admin1",
                role: "member",
            }),
        ).resolves.toMatchObject({ ok: true });
    });

    it("translates the DB trigger's 23514 into the same verdict", async () => {
        // The in-process count races; the trigger is the real guard. When it
        // fires, the caller must see `last_admin`, not a 500.
        const db = makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "admin1", role: "admin" },
                { id: "m2", org_id: "o1", user_id: "admin2", role: "admin" },
            ],
        });
        const realFrom = db.from.bind(db);
        db.from = (table: string) => {
            const builder = realFrom(table);
            if (table !== "org_members") return builder;
            const originalUpdate = builder.update.bind(builder);
            builder.update = (payload: Row) => {
                originalUpdate(payload);
                builder.single = async () => ({
                    data: null,
                    error: {
                        code: "23514",
                        message:
                            'new row violates check "An organization must keep at least one admin"',
                    },
                });
                return builder;
            };
            return builder;
        };
        await expect(
            updateMember(db, {
                actorId: "admin1",
                orgId: "o1",
                targetUserId: "admin2",
                role: "member",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "last_admin" });
    });

    it("lets a plain member leave on their own", async () => {
        const db = seedSoleAdmin();
        await expect(
            removeMember(db, {
                actorId: "member1",
                orgId: "o1",
                targetUserId: "member1",
            }),
        ).resolves.toMatchObject({ ok: true });
        expect(db._tables.org_members).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

function seedOrg() {
    return makeDb({
        organizations: [{ id: "o1", name: "Acme" }],
        org_members: [
            { id: "m1", org_id: "o1", user_id: "admin1", role: "admin" },
            { id: "m2", org_id: "o1", user_id: "member1", role: "member" },
        ],
        user_profiles: [
            { user_id: "admin1", email: "admin@acme.example" },
            { user_id: "member1", email: "member@acme.example" },
            { user_id: "newbie", email: "newbie@acme.example" },
        ],
        org_invitations: [],
    });
}

describe("org invitations", () => {
    it("an admin can invite an email at a role", async () => {
        const db = seedOrg();
        const result = await createInvitation(db, {
            actorId: "admin1",
            actorEmail: "admin@acme.example",
            orgId: "o1",
            email: "  Newbie@Acme.Example ",
            role: "member",
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Normalized on the way in, so duplicate detection and the
        // claim-after-signup email match both work on one canonical form.
        expect(result.invitation.email).toBe("newbie@acme.example");
        expect(result.invitation.status).toBe("pending");
        // Crucially: no membership yet.
        expect(db._tables.org_members).toHaveLength(2);
    });

    it("a pending invitation grants no access", async () => {
        const db = seedOrg();
        await createInvitation(db, {
            actorId: "admin1",
            orgId: "o1",
            email: "newbie@acme.example",
            role: "admin",
        });
        await expect(
            getOrg(db, { userId: "newbie", orgId: "o1" }),
        ).resolves.toMatchObject({ ok: false, kind: "not_found" });
    });

    it("a plain member cannot invite", async () => {
        const db = seedOrg();
        await expect(
            createInvitation(db, {
                actorId: "member1",
                orgId: "o1",
                email: "newbie@acme.example",
                role: "member",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "forbidden" });
    });

    it("rejects a malformed address and self-invitation", async () => {
        const db = seedOrg();
        await expect(
            createInvitation(db, {
                actorId: "admin1",
                orgId: "o1",
                email: "not-an-email",
                role: "member",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "validation" });
        await expect(
            createInvitation(db, {
                actorId: "admin1",
                actorEmail: "admin@acme.example",
                orgId: "o1",
                email: "Admin@Acme.example",
                role: "member",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "validation" });
    });

    it("refuses a duplicate while one is still live, and an existing member", async () => {
        const db = seedOrg();
        await createInvitation(db, {
            actorId: "admin1",
            orgId: "o1",
            email: "newbie@acme.example",
            role: "member",
        });
        await expect(
            createInvitation(db, {
                actorId: "admin1",
                orgId: "o1",
                email: "newbie@acme.example",
                role: "admin",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "conflict" });

        await expect(
            createInvitation(db, {
                actorId: "admin1",
                orgId: "o1",
                email: "member@acme.example",
                role: "member",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "conflict" });
    });

    it("re-opens an expired invitation in place rather than stacking rows", async () => {
        const db = seedOrg();
        (db._tables.org_invitations as Row[]).push({
            id: "i-old",
            org_id: "o1",
            email: "newbie@acme.example",
            role: "member",
            status: "pending",
            expires_at: new Date(Date.now() - 1000).toISOString(),
        });
        const result = await createInvitation(db, {
            actorId: "admin1",
            orgId: "o1",
            email: "newbie@acme.example",
            role: "admin",
        });
        expect(result.ok).toBe(true);
        expect(db._tables.org_invitations).toHaveLength(1);
        if (!result.ok) return;
        expect(result.invitation).toMatchObject({ id: "i-old", role: "admin" });
        expect(result.invitation.status).toBe("pending");
    });

    it("accepting creates the membership at the invited role", async () => {
        const db = seedOrg();
        const created = await createInvitation(db, {
            actorId: "admin1",
            orgId: "o1",
            email: "newbie@acme.example",
            role: "admin",
        });
        if (!created.ok) throw new Error("setup failed");
        const inviteId = created.invitation.id as string;

        const result = await acceptInvitation(db, {
            userId: "newbie",
            userEmail: "Newbie@Acme.Example",
            invitationId: inviteId,
        });
        expect(result).toMatchObject({ ok: true, org_id: "o1", role: "admin" });
        const members = db._tables.org_members as Row[];
        expect(members).toHaveLength(3);
        expect(members[2]).toMatchObject({ user_id: "newbie", role: "admin" });
        const invite = (db._tables.org_invitations as Row[])[0];
        expect(invite.status).toBe("accepted");
        expect(invite.accepted_at).toBeTruthy();
    });

    it("declining records the answer and creates nothing", async () => {
        const db = seedOrg();
        const created = await createInvitation(db, {
            actorId: "admin1",
            orgId: "o1",
            email: "newbie@acme.example",
            role: "member",
        });
        if (!created.ok) throw new Error("setup failed");
        await expect(
            declineInvitation(db, {
                userId: "newbie",
                userEmail: "newbie@acme.example",
                invitationId: created.invitation.id as string,
            }),
        ).resolves.toMatchObject({ ok: true });
        expect(db._tables.org_members).toHaveLength(2);
        expect((db._tables.org_invitations as Row[])[0].status).toBe("declined");
    });

    it("only the addressed account can answer, and a mismatch reads as missing", async () => {
        const db = seedOrg();
        const created = await createInvitation(db, {
            actorId: "admin1",
            orgId: "o1",
            email: "newbie@acme.example",
            role: "member",
        });
        if (!created.ok) throw new Error("setup failed");
        // 404 rather than 403: a 403 would confirm the invitation exists for
        // somebody else.
        await expect(
            acceptInvitation(db, {
                userId: "intruder",
                userEmail: "intruder@elsewhere.example",
                invitationId: created.invitation.id as string,
            }),
        ).resolves.toMatchObject({ ok: false, kind: "not_found" });
        expect(db._tables.org_members).toHaveLength(2);
    });

    it("cannot accept an expired invitation", async () => {
        const db = seedOrg();
        (db._tables.org_invitations as Row[]).push({
            id: "i-exp",
            org_id: "o1",
            email: "newbie@acme.example",
            role: "member",
            status: "pending",
            expires_at: new Date(Date.now() - 1000).toISOString(),
        });
        await expect(
            acceptInvitation(db, {
                userId: "newbie",
                userEmail: "newbie@acme.example",
                invitationId: "i-exp",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "expired" });
        expect(db._tables.org_members).toHaveLength(2);
    });

    // An invitation can outlive the state it was written for: it is created
    // against a roster, sits pending for up to 14 days, and is answered
    // against whatever the roster looks like then. The recipient may have
    // joined in the meantime — an org's creator is a member the moment the
    // org exists, and a second invitation can be sent by a second admin.
    const seedPendingInvite = (
        db: ReturnType<typeof seedOrg>,
        role: "admin" | "member",
    ) => {
        (db._tables.org_invitations as Row[]).push({
            id: "inv-standing",
            org_id: "o1",
            email: "member@acme.example",
            role,
            status: "pending",
            invited_by: "admin1",
            expires_at: new Date(Date.now() + 86_400_000).toISOString(),
            created_at: "t1",
        });
        return "inv-standing";
    };

    it("upgrades an existing member accepting an admin invitation", async () => {
        const db = seedOrg();
        const inviteId = seedPendingInvite(db, "admin");

        const result = await acceptInvitation(db, {
            userId: "member1",
            userEmail: "member@acme.example",
            invitationId: inviteId,
        });

        expect(result).toMatchObject({ ok: true, role: "admin" });
        // The membership itself moved — not just the response.
        expect(
            (db._tables.org_members as Row[]).find(
                (m) => m.user_id === "member1",
            )?.role,
        ).toBe("admin");
        expect(
            (db._tables.org_invitations as Row[])[0].status,
        ).toBe("accepted");
    });

    it("never demotes an admin who accepts a member invitation", async () => {
        // Roles are floors, not ceilings. An invitation is an offer of access,
        // not an instruction to reduce it, and quietly demoting the org's only
        // admin by way of a stale invitation would trip the last-admin guard
        // on the way past.
        const db = seedOrg();
        (db._tables.org_invitations as Row[]).push({
            id: "inv-weak",
            org_id: "o1",
            email: "admin@acme.example",
            role: "member",
            status: "pending",
            invited_by: "admin1",
            expires_at: new Date(Date.now() + 86_400_000).toISOString(),
            created_at: "t1",
        });

        const result = await acceptInvitation(db, {
            userId: "admin1",
            userEmail: "admin@acme.example",
            invitationId: "inv-weak",
        });

        expect(result).toMatchObject({ ok: true, role: "admin" });
        expect(
            (db._tables.org_members as Row[]).find(
                (m) => m.user_id === "admin1",
            )?.role,
        ).toBe("admin");
        // Answered either way: a live invitation nobody can act on is worse
        // than one that is closed.
        expect((db._tables.org_invitations as Row[])[0].status).toBe(
            "accepted",
        );
    });

    it("cannot answer an invitation twice", async () => {
        const db = seedOrg();
        const created = await createInvitation(db, {
            actorId: "admin1",
            orgId: "o1",
            email: "newbie@acme.example",
            role: "member",
        });
        if (!created.ok) throw new Error("setup failed");
        const inviteId = created.invitation.id as string;
        await acceptInvitation(db, {
            userId: "newbie",
            userEmail: "newbie@acme.example",
            invitationId: inviteId,
        });
        await expect(
            declineInvitation(db, {
                userId: "newbie",
                userEmail: "newbie@acme.example",
                invitationId: inviteId,
            }),
        ).resolves.toMatchObject({ ok: false, kind: "conflict" });
    });

    it("an admin can cancel a pending invitation, killing acceptance", async () => {
        const db = seedOrg();
        const created = await createInvitation(db, {
            actorId: "admin1",
            orgId: "o1",
            email: "newbie@acme.example",
            role: "member",
        });
        if (!created.ok) throw new Error("setup failed");
        const inviteId = created.invitation.id as string;
        await expect(
            cancelInvitation(db, {
                actorId: "admin1",
                orgId: "o1",
                invitationId: inviteId,
            }),
        ).resolves.toMatchObject({ ok: true });
        expect((db._tables.org_invitations as Row[])[0].status).toBe("cancelled");
        await expect(
            acceptInvitation(db, {
                userId: "newbie",
                userEmail: "newbie@acme.example",
                invitationId: inviteId,
            }),
            // not_found, not conflict: "already answered" would tell the
            // recipient something untrue — an admin withdrew it; they never
            // answered. The client maps 404 to "It may have been cancelled."
        ).resolves.toMatchObject({ ok: false, kind: "not_found" });
    });

    it("resending pushes the expiry out without re-opening an answered one", async () => {
        const db = seedOrg();
        (db._tables.org_invitations as Row[]).push({
            id: "i-exp",
            org_id: "o1",
            email: "newbie@acme.example",
            role: "member",
            status: "pending",
            expires_at: new Date(Date.now() - 1000).toISOString(),
        });
        const resent = await resendInvitation(db, {
            actorId: "admin1",
            orgId: "o1",
            invitationId: "i-exp",
        });
        expect(resent.ok).toBe(true);
        if (!resent.ok) return;
        expect(resent.invitation.status).toBe("pending");
        expect(
            new Date(resent.invitation.expires_at as string).getTime(),
        ).toBeGreaterThan(Date.now());

        (db._tables.org_invitations as Row[])[0].status = "declined";
        await expect(
            resendInvitation(db, {
                actorId: "admin1",
                orgId: "o1",
                invitationId: "i-exp",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "conflict" });
    });

    it("only admins may read or cancel the invitation roster", async () => {
        const db = seedOrg();
        await expect(
            listInvitations(db, { userId: "member1", orgId: "o1" }),
        ).resolves.toMatchObject({ ok: false, kind: "forbidden" });
        await expect(
            cancelInvitation(db, {
                actorId: "member1",
                orgId: "o1",
                invitationId: "whatever",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "forbidden" });
    });

    it("surfaces an invitation created before the recipient had an account", async () => {
        // claim-after-signup: the invitation is addressed to an email, and the
        // account that later owns that email finds it waiting.
        const db = makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "admin1", role: "admin" },
            ],
            user_profiles: [{ user_id: "admin1", email: "admin@acme.example" }],
            org_invitations: [],
        });
        const created = await createInvitation(db, {
            actorId: "admin1",
            orgId: "o1",
            email: "future@acme.example",
            role: "member",
        });
        expect(created.ok).toBe(true);

        const mine = await listMyInvitations(db, {
            userEmail: "Future@Acme.example",
        });
        expect(mine).toMatchObject({ ok: true });
        if (!mine.ok) return;
        expect(mine.invitations).toHaveLength(1);
        expect(mine.invitations[0]).toMatchObject({
            org_id: "o1",
            org_name: "Acme",
            role: "member",
        });

        // And the brand-new account can accept it.
        await expect(
            acceptInvitation(db, {
                userId: "future-user",
                userEmail: "future@acme.example",
                invitationId: (created.ok && created.invitation.id) as string,
            }),
        ).resolves.toMatchObject({ ok: true, role: "member" });
    });

    it("omits expired invitations from the recipient's list", async () => {
        const db = seedOrg();
        (db._tables.org_invitations as Row[]).push({
            id: "i-exp",
            org_id: "o1",
            email: "newbie@acme.example",
            role: "member",
            status: "pending",
            expires_at: new Date(Date.now() - 1000).toISOString(),
        });
        const mine = await listMyInvitations(db, {
            userEmail: "newbie@acme.example",
        });
        expect(mine).toMatchObject({ ok: true, invitations: [] });
    });

    it("records the lifecycle in the audit trail", async () => {
        const db = seedOrg();
        const created = await createInvitation(db, {
            actorId: "admin1",
            actorEmail: "admin@acme.example",
            orgId: "o1",
            email: "newbie@acme.example",
            role: "member",
        });
        if (!created.ok) throw new Error("setup failed");
        await acceptInvitation(db, {
            userId: "newbie",
            userEmail: "newbie@acme.example",
            invitationId: created.invitation.id as string,
        });
        const actions = (db._tables.audit_events as Row[]).map((e) => e.action);
        expect(actions).toEqual([
            "org.invite.created",
            "org.invite.accepted",
        ]);
    });
});
