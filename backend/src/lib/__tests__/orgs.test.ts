import { describe, expect, it, vi } from "vitest";
import { ownerlessRpcResult } from "../../__tests__/helpers/ownerlessRpc";
import { handoverRpcResult } from "../../__tests__/helpers/handoverRpc";
import {
    acceptInvitation,
    cancelInvitation,
    createInvitation,
    createOrg,
    declineInvitation,
    deleteOrg,
    getMemberHandover,
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
            | { type: "eq" | "is"; col: string; val: unknown }
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
                    f.type === "in"
                        ? f.vals.includes(r[f.col])
                        : f.type === "is"
                          ? (r[f.col] ?? null) === f.val
                          : r[f.col] === f.val,
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
            is: (col: string, val: unknown) => {
                filters.push({ type: "is", col, val });
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
        // Whether an item has an Owner left is the database's to say.
        // ... and so is what a departing member alone owns.
        rpc: async (name: string, args?: Record<string, unknown>) =>
            (name === "soft_delete_organization" ? (() => {
                const org = tables.organizations.find((row) => row.id === args?.p_org_id);
                if (org) { org.deleted_at = new Date().toISOString(); org.purge_after = new Date(Date.now() + 30 * 86400000).toISOString(); }
                return { data: null, error: null };
            })() : null) ??
            (name === "list_org_private_content_access" ? { data: [], error: null } : null) ??
            ownerlessRpcResult(tables, name, args) ??
            handoverRpcResult(tables, name, args) ?? {
                data: null,
                error: { message: `unexpected rpc ${name}` },
            },
        _tables: tables,
        _selects: selects,
    } as any;
}



// ---------------------------------------------------------------------------
// Roles: owner / admin / member
// ---------------------------------------------------------------------------

describe("orgs.service roles", () => {
    it("createOrg makes the creator an owner", async () => {
        const db = makeDb({});
        const result = await createOrg(db, { userId: "u1", name: "Acme" });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.org.role).toBe("owner");
        const members = db._tables.org_members as Row[];
        expect(members).toHaveLength(1);
        expect(members[0]).toMatchObject({ user_id: "u1", role: "owner" });
        expect(db._tables.audit_events).toEqual([expect.objectContaining({
            user_id: "u1", org_id: result.org.id, action: "org.created", title: "Acme", surface: "organization",
        })]);
    });

    it("rejects a blank org name", async () => {
        const db = makeDb({});
        const result = await createOrg(db, { userId: "u1", name: "  " });
        expect(result).toMatchObject({ ok: false, kind: "validation" });
    });

    it("lets an owner appoint another owner", async () => {
        const db = makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "owner1", role: "owner" },
                { id: "m2", org_id: "o1", user_id: "member1", role: "member" },
            ],
        });
        const result = await updateMember(db, {
            actorId: "owner1",
            orgId: "o1",
            targetUserId: "member1",
            role: "owner",
        });
        expect(result).toMatchObject({ ok: true });
        expect(
            (db._tables.org_members as Row[]).find(
                (m) => m.user_id === "member1",
            )?.role,
        ).toBe("owner");
    });

    it("rejects a role that does not exist", async () => {
        const db = makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "owner1", role: "owner" },
                { id: "m2", org_id: "o1", user_id: "member1", role: "member" },
            ],
        });
        const result = await updateMember(db, {
            actorId: "owner1",
            orgId: "o1",
            targetUserId: "member1",
            role: "superuser",
        });
        expect(result).toMatchObject({ ok: false, kind: "validation" });
    });

    const seedPair = () =>
        makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "owner1", role: "owner" },
                { id: "m2", org_id: "o1", user_id: "member1", role: "member" },
            ],
        });

    it("lets an owner promote a member to admin", async () => {
        const db = seedPair();
        await expect(
            updateMember(db, {
                actorId: "owner1",
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
                actorId: "owner1",
                actorEmail: "owner1@example.com",
                orgId: "o1",
                targetUserId: "member1",
                role: "admin",
            }),
        ).resolves.toMatchObject({ ok: true });
        await expect(
            removeMember(db, {
                actorId: "owner1",
                actorEmail: "owner1@example.com",
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
            user_id: "owner1",
            user_email: "owner1@example.com",
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
                { id: "m1", org_id: "o1", user_id: "owner1", role: "owner" },
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
                targetUserId: "owner1",
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
                { id: "m1", org_id: "o1", user_id: "owner1", role: "owner" },
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
                { id: "m1", org_id: "o1", user_id: "owner1", role: "owner" },
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

    it("leaves out a person's own personal organization", async () => {
        const db = makeDb({
            organizations: [
                { id: "o1", name: "Acme", kind: "team" },
                {
                    id: "mine",
                    name: "Personal",
                    kind: "personal",
                    personal_user_id: "member1",
                },
            ],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "member1", role: "member" },
                { id: "m2", org_id: "mine", user_id: "member1", role: "owner" },
            ],
        });
        const result = await listMyOrgs(db, "member1");
        expect(result).toMatchObject({ ok: true });
        if (!result.ok) return;
        expect(result.orgs.map((org) => (org as { id: string }).id)).toEqual([
            "o1",
        ]);
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
                    visibility: "organization",
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
            "id, user_id, org_id, visibility, title, type, practice, created_at",
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
                { id: "walled", user_id: "member2", org_id: "o1", visibility: "organization", name: "Project Nimbus", cm_number: "1234-5678" },
                { id: "open", user_id: "member2", org_id: "o1", visibility: "organization", name: "Shared matter" },
            ],
            workflows: [
                { id: "walled-wf", user_id: "member2", org_id: "o1", visibility: "organization", title: "Nimbus diligence" },
                { id: "open-wf", user_id: "member2", org_id: "o1", visibility: "organization", title: "Standard diligence" },
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

    // Mirrors project_access_role: a denial cannot bind an organization
    // owner or the resource's creator, and validate_org_access_override
    // refuses to write one. A stale row must not hide the resource from them.
    // An admin has no such standing: a wall holds against one.
    it("ignores a stale denial against an owner or the creator, but not against an admin", async () => {
        const db = makeDb({
            org_members: [
                { org_id: "o1", user_id: "owner1", role: "owner" },
                { org_id: "o1", user_id: "orgadmin1", role: "admin" },
                { org_id: "o1", user_id: "creator1", role: "member" },
            ],
            projects: [
                { id: "p1", user_id: "creator1", org_id: "o1", visibility: "organization", name: "Matter" },
            ],
            workflows: [],
            project_org_access_overrides: [
                { project_id: "p1", org_id: "o1", user_id: "owner1", role: "deny" },
                { project_id: "p1", org_id: "o1", user_id: "orgadmin1", role: "deny" },
                { project_id: "p1", org_id: "o1", user_id: "creator1", role: "deny" },
            ],
            workflow_org_access_overrides: [],
        });

        for (const userId of ["owner1", "creator1"]) {
            const result = await listOrgResources(db, { userId, orgId: "o1" });
            expect(result).toMatchObject({ ok: true });
            if (!result.ok) return;
            expect(result.projects).toEqual([
                expect.objectContaining({ id: "p1" }),
            ]);
        }
        const admin = await listOrgResources(db, {
            userId: "orgadmin1",
            orgId: "o1",
        });
        expect(admin).toMatchObject({ ok: true, projects: [] });
    });

    // Private by default: being in the organization is not, on its own, a
    // reason to see a matter. The name and matter number of a private project
    // are what privacy withholds, so the row must not travel at all.
    it("lists a private project or workflow only for its creator and the members it was shared with", async () => {
        const db = makeDb({
            org_members: [
                { org_id: "o1", user_id: "owner1", role: "owner" },
                { org_id: "o1", user_id: "orgadmin1", role: "admin" },
                { org_id: "o1", user_id: "creator1", role: "member" },
                { org_id: "o1", user_id: "shared1", role: "member" },
                { org_id: "o1", user_id: "member1", role: "member" },
            ],
            projects: [
                { id: "secret", user_id: "creator1", org_id: "o1", visibility: "private", name: "Project Nimbus", cm_number: "1234-5678" },
            ],
            workflows: [
                { id: "secret-wf", user_id: "creator1", org_id: "o1", visibility: "private", title: "Nimbus diligence" },
            ],
            project_org_access_overrides: [
                { project_id: "secret", org_id: "o1", user_id: "shared1", role: "viewer" },
            ],
            workflow_org_access_overrides: [
                { workflow_id: "secret-wf", org_id: "o1", user_id: "shared1", role: "editor" },
            ],
        });

        for (const userId of ["creator1", "shared1"]) {
            const result = await listOrgResources(db, { userId, orgId: "o1" });
            expect(result).toMatchObject({
                ok: true,
                projects: [expect.objectContaining({ id: "secret" })],
                workflows: [expect.objectContaining({ id: "secret-wf" })],
            });
        }
        // Owning or running the organization is not a reason to see it.
        for (const userId of ["owner1", "orgadmin1", "member1"]) {
            const result = await listOrgResources(db, { userId, orgId: "o1" });
            expect(result).toEqual({ ok: true, projects: [], workflows: [] });
            expect(JSON.stringify(result)).not.toContain("Nimbus");
        }
    });

    it("hands the organization's owners a private item whose creator has left", async () => {
        const db = makeDb({
            org_members: [
                { org_id: "o1", user_id: "owner1", role: "owner" },
                { org_id: "o1", user_id: "orgadmin1", role: "admin" },
                { org_id: "o1", user_id: "shared1", role: "member" },
            ],
            projects: [
                // Nobody else was made an Owner: a Viewer is not one.
                { id: "orphan", user_id: "departed", org_id: "o1", visibility: "private", name: "Left behind" },
                // Still has an Owner among the members.
                { id: "kept", user_id: "departed", org_id: "o1", visibility: "private", name: "Handed over" },
            ],
            workflows: [
                { id: "orphan-wf", user_id: "departed", org_id: "o1", visibility: "private", title: "Left behind" },
            ],
            project_org_access_overrides: [
                { project_id: "orphan", org_id: "o1", user_id: "shared1", role: "viewer" },
                { project_id: "kept", org_id: "o1", user_id: "shared1", role: "owner" },
            ],
            workflow_org_access_overrides: [],
        });

        const owner = await listOrgResources(db, { userId: "owner1", orgId: "o1" });
        expect(owner).toMatchObject({
            ok: true,
            projects: [expect.objectContaining({ id: "orphan" })],
            workflows: [expect.objectContaining({ id: "orphan-wf" })],
        });
        if (owner.ok) expect(owner.projects).toHaveLength(1);

        // An admin gains nothing from the departure.
        await expect(
            listOrgResources(db, { userId: "orgadmin1", orgId: "o1" }),
        ).resolves.toEqual({ ok: true, projects: [], workflows: [] });
    });

    it("treats a row with no visibility as private", async () => {
        // Fail closed: a row this code cannot classify must not be listed for
        // the whole organization.
        const db = makeDb({
            org_members: [{ org_id: "o1", user_id: "member1", role: "member" }],
            projects: [{ id: "p1", user_id: "someone", org_id: "o1", name: "Matter" }],
            workflows: [],
        });
        await expect(
            listOrgResources(db, { userId: "member1", orgId: "o1" }),
        ).resolves.toEqual({ ok: true, projects: [], workflows: [] });
    });

    it("scopes the denial lookup to the caller, not to the whole org", async () => {
        const db = makeDb({
            org_members: [
                { org_id: "o1", user_id: "member1", role: "member" },
                { org_id: "o1", user_id: "member2", role: "member" },
            ],
            projects: [
                { id: "p1", user_id: "someone", org_id: "o1", visibility: "organization", name: "Matter" },
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
// The database-backed "at least one owner" rule, at the service layer
// ---------------------------------------------------------------------------

describe("last-owner protection", () => {
    const seedSoleOwner = () =>
        makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "owner1", role: "owner" },
                { id: "m2", org_id: "o1", user_id: "member1", role: "member" },
            ],
        });

    it("refuses to demote the last owner", async () => {
        const db = seedSoleOwner();
        await expect(
            updateMember(db, {
                actorId: "owner1",
                orgId: "o1",
                targetUserId: "owner1",
                role: "member",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "last_owner" });
    });

    it("refuses to remove the last owner, even by their own hand", async () => {
        const db = seedSoleOwner();
        await expect(
            removeMember(db, {
                actorId: "owner1",
                orgId: "o1",
                targetUserId: "owner1",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "last_owner" });
    });

    it("allows both once a second owner exists", async () => {
        const db = makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "owner1", role: "owner" },
                { id: "m2", org_id: "o1", user_id: "owner2", role: "owner" },
            ],
        });
        await expect(
            updateMember(db, {
                actorId: "owner1",
                orgId: "o1",
                targetUserId: "owner1",
                role: "member",
            }),
        ).resolves.toMatchObject({ ok: true });
    });

    it("translates the DB trigger's 23514 into the same verdict", async () => {
        // The in-process count races; the trigger is the real guard. When it
        // fires, the caller must see `last_owner`, not a 500.
        const db = makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "owner1", role: "owner" },
                { id: "m2", org_id: "o1", user_id: "owner2", role: "owner" },
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
                            'new row violates check "An organization must keep at least one owner"',
                    },
                });
                return builder;
            };
            return builder;
        };
        await expect(
            updateMember(db, {
                actorId: "owner1",
                orgId: "o1",
                targetUserId: "owner2",
                role: "member",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "last_owner" });
    });

    it("lets a plain member leave on their own", async () => {
        const db = seedSoleOwner();
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
// What becomes of a member's work when they leave
// ---------------------------------------------------------------------------
//
// Projects and workflows are the organization's lasting work: the
// public ones a departing member alone owns are handed to a member named by whoever
// is doing the removing — the admin, or the member themselves when leaving.
// Standalone chats and reviews are private to their author and are deleted
// with the membership (by the database; see the SQL tests).

describe("handing over a departing member's work", () => {
    // dana (owner), alex (admin), sam and robin (members). sam's work:
    //   p-private   a private project, sam's alone
    //   p-shared    a private project robin was made an Owner of
    //   p-public    a public project: the organization's owners own those
    //   w-private   a private workflow, sam's alone
    //   two standalone chats (robin owns one of them too) and a review
    const seed = () =>
        makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "dana", role: "owner" },
                { id: "m2", org_id: "o1", user_id: "alex", role: "admin" },
                { id: "m3", org_id: "o1", user_id: "sam", role: "member" },
                { id: "m4", org_id: "o1", user_id: "robin", role: "member" },
            ],
            user_profiles: [
                { user_id: "sam", email: "sam@acme.example" },
                { user_id: "robin", email: "robin@acme.example" },
            ],
            projects: [
                { id: "p-private", org_id: "o1", user_id: "sam", name: "Private matter", visibility: "private" },
                { id: "p-shared", org_id: "o1", user_id: "sam", name: "Shared matter", visibility: "private" },
                { id: "p-public", org_id: "o1", user_id: "sam", name: "Public matter", visibility: "organization" },
            ],
            project_org_access_overrides: [
                { project_id: "p-shared", org_id: "o1", user_id: "robin", role: "owner" },
            ],
            workflows: [
                { id: "w-private", org_id: "o1", user_id: "sam", title: "Private workflow", visibility: "private" },
                { id: "w-public", org_id: "o1", user_id: "sam", title: "Public workflow", visibility: "organization" },
            ],
            workflow_org_access_overrides: [],
            chats: [
                { id: "c1", org_id: "o1", user_id: "sam", project_id: null },
                { id: "c2", org_id: "o1", user_id: "sam", project_id: null },
                { id: "c3", org_id: "o1", user_id: "sam", project_id: "p-public" },
            ],
            chat_access_grants: [
                { chat_id: "c2", email: "robin@acme.example", role: "owner" },
            ],
            tabular_reviews: [
                { id: "r1", org_id: "o1", user_id: "sam", project_id: null },
            ],
            tabular_review_access_grants: [],
            // Two of his own in the organization's library; the one in a
            // project, the workflow's asset and a colleague's are not his
            // to lose.
            documents: [
                { id: "d1", org_id: "o1", user_id: "sam", project_id: null },
                { id: "d2", org_id: "o1", user_id: "sam", project_id: null },
                { id: "d3", org_id: "o1", user_id: "sam", project_id: "p-public" },
                { id: "d4", org_id: "o1", user_id: "sam", project_id: null, workflow_id: "w-private" },
                { id: "d5", org_id: "o1", user_id: "robin", project_id: null },
            ],
        });
    const remove = (db: any, actorId: string, assignTo?: unknown) =>
        removeMember(db, {
            actorId,
            actorEmail: `${actorId}@acme.example`,
            orgId: "o1",
            targetUserId: "sam",
            assignTo,
        });
    const isMember = (db: any, userId: string) =>
        (db._tables.org_members as Row[]).some((m) => m.user_id === userId);

    it("says what a removal would hand over and archive", async () => {
        const db = seed();
        await expect(
            getMemberHandover(db, {
                actorId: "alex",
                orgId: "o1",
                targetUserId: "sam",
            }),
        ).resolves.toEqual({
            ok: true,
            handover: {
                // Only public titles are disclosed; private work is counted.
                projects: [{ id: "p-public", title: "Public matter" }],
                workflows: [{ id: "w-public", title: "Public workflow" }],
                privateProjects: 1,
                privateWorkflows: 1,
                // Not the chat robin also owns, nor the one in a project.
                chats: 1,
                reviews: 1,
                documents: 2,
                sharedChats: 0,
                sharedReviews: 0,
                sharedDocuments: 0,
            },
        });
    });

    it("needs no successor when only private work remains", async () => {
        const db = seed();
        db._tables.projects = db._tables.projects.filter((row: Row) => row.visibility !== "organization");
        db._tables.workflows = db._tables.workflows.filter((row: Row) => row.visibility !== "organization");
        await expect(remove(db, "alex", "alex")).resolves.toEqual({ ok: true });
        expect(db._tables.project_org_access_overrides).not.toEqual(
            expect.arrayContaining([expect.objectContaining({ user_id: "alex" })]),
        );
        expect(db._tables.workflow_org_access_overrides).toEqual([]);
    });

    it("counts a shared private item once when all its owners are selected", async () => {
        const db = seed();
        await expect(getMemberHandover(db, {
            actorId: "alex", orgId: "o1", targetUserId: "sam", departingUserIds: ["sam", "robin"],
        })).resolves.toMatchObject({ ok: true, handover: {
            privateProjects: 2, privateWorkflows: 1, chats: 2,
        } });
    });

    it("authorizes every person in a bulk preview", async () => {
        const db = seed();
        await expect(getMemberHandover(db, {
            actorId: "alex", orgId: "o1", targetUserId: "sam", departingUserIds: ["dana"],
        })).resolves.toMatchObject({ ok: false, kind: "owner_required" });
    });

    it("answers that question only to somebody who could remove them", async () => {
        const db = seed();
        const ask = (actorId: string) =>
            getMemberHandover(db, { actorId, orgId: "o1", targetUserId: "sam" });
        await expect(ask("sam")).resolves.toMatchObject({ ok: true });
        await expect(ask("robin")).resolves.toEqual({
            ok: false,
            kind: "forbidden",
        });
        await expect(ask("stranger")).resolves.toEqual({
            ok: false,
            kind: "not_found",
        });
    });

    it.each(["alex", "sam"])(
        "lets %s remove a member with the default organization-owner successor",
        async (actorId) => {
            const db = seed();
            const rpc = vi.spyOn(db, "rpc");
            await expect(remove(db, actorId)).resolves.toEqual({ ok: true });
            expect(rpc).toHaveBeenCalledWith("remove_org_member", {
                p_org_id: "o1", p_user_id: "sam", p_actor_id: actorId, p_successor_id: null,
            });
            expect(isMember(db, "sam")).toBe(false);
            expect(db._tables.projects.find((row: Row) => row.id === "p-private")).toMatchObject({
                archived_at: expect.any(String), user_id: null,
            });
        },
    );

    it.each([
        ["the departing member themselves", "sam"],
        ["somebody outside the organization", "stranger"],
        ["something that is not an id", 42],
    ])("refuses %s as the successor", async (_label, assignTo) => {
        const db = seed();
        await expect(remove(db, "alex", assignTo)).resolves.toMatchObject({
            ok: false,
            kind: "validation",
        });
        expect(isMember(db, "sam")).toBe(true);
    });

    it("hands the member's own projects and workflows to the named successor, then removes them", async () => {
        const db = seed();
        await expect(remove(db, "alex", "robin")).resolves.toEqual({ ok: true });

        expect(isMember(db, "sam")).toBe(false);
        expect(db._tables.project_org_access_overrides).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    project_id: "p-public",
                    user_id: "robin",
                    role: "owner",
                    assigned_by: "alex",
                }),
            ]),
        );
        expect(db._tables.workflow_org_access_overrides).toEqual([
            expect.objectContaining({
                workflow_id: "w-public",
                user_id: "robin",
                role: "owner",
            }),
        ]);
        // Private work is never handed to the successor.
        expect(
            (db._tables.project_org_access_overrides as Row[]).some(
                (o) => o.project_id === "p-private",
            ),
        ).toBe(false);
    });

    it("records the successor and counts of transferred and archived work", async () => {
        const db = seed();
        await remove(db, "alex", "robin");
        expect(db._tables.audit_events).toEqual([
            expect.objectContaining({
                action: "org.member.removed",
                detail: expect.objectContaining({
                    target_user_id: "sam",
                    assigned_to: "robin",
                    assigned_projects: 1,
                    assigned_workflows: 1,
                    archived_projects: 1,
                    archived_workflows: 1,
                    archived_chats: 1,
                    archived_reviews: 1,
                    archived_documents: 2,
                }),
            }),
        ]);
    });

    it("lets a member who is leaving name their own successor", async () => {
        const db = seed();
        await expect(remove(db, "sam", "dana")).resolves.toEqual({ ok: true });
        expect(isMember(db, "sam")).toBe(false);
        expect(db._tables.audit_events).toEqual([
            expect.objectContaining({
                action: "org.member.left",
                detail: expect.objectContaining({ assigned_to: "dana" }),
            }),
        ]);
    });

    it("asks for nobody when the member owns nothing alone", async () => {
        const db = seed();
        await expect(
            removeMember(db, {
                actorId: "alex",
                orgId: "o1",
                targetUserId: "robin",
            }),
        ).resolves.toEqual({ ok: true });
        expect(isMember(db, "robin")).toBe(false);
    });

    it("removes nobody when the hand-over cannot be read", async () => {
        const db = seed();
        db.rpc = async () => ({
            data: null,
            error: { message: "connection reset" },
        });
        await expect(remove(db, "alex", "robin")).resolves.toMatchObject({
            ok: false,
            kind: "db_error",
        });
        expect(isMember(db, "sam")).toBe(true);
    });

    it("refuses removal until the departure migration is installed", async () => {
        const db = seed();
        db.rpc = async () => ({
            data: null,
            error: { code: "PGRST202", message: "function not found" },
        });
        await expect(remove(db, "alex")).resolves.toMatchObject({ ok: false, kind: "db_error" });
        expect(isMember(db, "sam")).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

function seedOrg() {
    return makeDb({
        organizations: [{ id: "o1", name: "Acme" }],
        org_members: [
            { id: "m1", org_id: "o1", user_id: "owner1", role: "owner" },
            { id: "m2", org_id: "o1", user_id: "member1", role: "member" },
        ],
        user_profiles: [
            { user_id: "owner1", email: "owner@acme.example" },
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
            actorId: "owner1",
            actorEmail: "owner@acme.example",
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
            actorId: "owner1",
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
                actorId: "owner1",
                orgId: "o1",
                email: "not-an-email",
                role: "member",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "validation" });
        await expect(
            createInvitation(db, {
                actorId: "owner1",
                actorEmail: "owner@acme.example",
                orgId: "o1",
                email: "Owner@Acme.example",
                role: "member",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "validation" });
    });

    it("refuses a duplicate while one is still live, and an existing member", async () => {
        const db = seedOrg();
        await createInvitation(db, {
            actorId: "owner1",
            orgId: "o1",
            email: "newbie@acme.example",
            role: "member",
        });
        await expect(
            createInvitation(db, {
                actorId: "owner1",
                orgId: "o1",
                email: "newbie@acme.example",
                role: "admin",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "conflict" });

        await expect(
            createInvitation(db, {
                actorId: "owner1",
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
            actorId: "owner1",
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
            actorId: "owner1",
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
            actorId: "owner1",
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
            actorId: "owner1",
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
            invited_by: "owner1",
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

    it("never demotes an owner who accepts a member invitation", async () => {
        // Roles are floors, not ceilings. An invitation is an offer of access,
        // not an instruction to reduce it, and quietly demoting the org's only
        // owner by way of a stale invitation would trip the last-owner guard
        // on the way past.
        const db = seedOrg();
        (db._tables.org_invitations as Row[]).push({
            id: "inv-weak",
            org_id: "o1",
            email: "owner@acme.example",
            role: "member",
            status: "pending",
            invited_by: "owner1",
            expires_at: new Date(Date.now() + 86_400_000).toISOString(),
            created_at: "t1",
        });

        const result = await acceptInvitation(db, {
            userId: "owner1",
            userEmail: "owner@acme.example",
            invitationId: "inv-weak",
        });

        expect(result).toMatchObject({ ok: true, role: "owner" });
        expect(
            (db._tables.org_members as Row[]).find(
                (m) => m.user_id === "owner1",
            )?.role,
        ).toBe("owner");
        // Answered either way: a live invitation nobody can act on is worse
        // than one that is closed.
        expect((db._tables.org_invitations as Row[])[0].status).toBe(
            "accepted",
        );
    });

    it("cannot answer an invitation twice", async () => {
        const db = seedOrg();
        const created = await createInvitation(db, {
            actorId: "owner1",
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
            actorId: "owner1",
            orgId: "o1",
            email: "newbie@acme.example",
            role: "member",
        });
        if (!created.ok) throw new Error("setup failed");
        const inviteId = created.invitation.id as string;
        await expect(
            cancelInvitation(db, {
                actorId: "owner1",
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
            actorId: "owner1",
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
                actorId: "owner1",
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
                { id: "m1", org_id: "o1", user_id: "owner1", role: "owner" },
            ],
            user_profiles: [{ user_id: "owner1", email: "owner@acme.example" }],
            org_invitations: [],
        });
        const created = await createInvitation(db, {
            actorId: "owner1",
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
            actorId: "owner1",
            actorEmail: "owner@acme.example",
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

// ---------------------------------------------------------------------------
// Owner and admin are different powers
// ---------------------------------------------------------------------------
//
// The whole reason for a second tier: an admin runs the organization day to
// day, and anything that could end it or change who controls it stays with an
// owner. Every refusal below is `owner_required`, not `forbidden`, so the
// client can say which role would have been allowed.

function seedTiers() {
    return makeDb({
        organizations: [{ id: "o1", name: "Acme" }],
        org_members: [
            { id: "m1", org_id: "o1", user_id: "owner1", role: "owner" },
            { id: "m2", org_id: "o1", user_id: "owner2", role: "owner" },
            { id: "m3", org_id: "o1", user_id: "orgadmin1", role: "admin" },
            { id: "m4", org_id: "o1", user_id: "orgadmin2", role: "admin" },
            { id: "m5", org_id: "o1", user_id: "member1", role: "member" },
        ],
        user_profiles: [
            { user_id: "owner1", email: "owner@acme.example" },
            { user_id: "orgadmin1", email: "orgadmin@acme.example" },
            { user_id: "member1", email: "member@acme.example" },
            { user_id: "newbie", email: "newbie@acme.example" },
        ],
        org_invitations: [],
        projects: [],
        documents: [],
        chats: [],
        tabular_reviews: [],
        workflows: [],
    });
}

const roleOf = (db: any, userId: string) =>
    (db._tables.org_members as Row[]).find((m) => m.user_id === userId)?.role;

describe("owner and admin tiers", () => {
    it("lets only an owner delete the organization", async () => {
        const db = seedTiers();
        await expect(
            deleteOrg(db, { userId: "member1", orgId: "o1" }),
        ).resolves.toMatchObject({ ok: false, kind: "forbidden" });
        await expect(
            deleteOrg(db, { userId: "orgadmin1", orgId: "o1" }),
        ).resolves.toMatchObject({ ok: false, kind: "owner_required" });
        expect(db._tables.organizations).toHaveLength(1);
        // Nobody's content is touched on behalf of someone who may not delete.

        await expect(
            deleteOrg(db, { userId: "owner1", orgId: "o1" }),
        ).resolves.toMatchObject({ ok: true });
        expect(db._tables.organizations[0].deleted_at).toBeTruthy();
        expect(db._tables.org_members).toHaveLength(5);
    });

    it("reports lifecycle database failures without purging content", async () => {
        const db = seedTiers();
        db.rpc = vi.fn().mockResolvedValue({ error: { message: "write failed" } });
        await expect(deleteOrg(db, { userId: "owner1", orgId: "o1" })).resolves.toMatchObject({ ok: false, kind: "db_error" });
        expect(db._tables.organizations[0].deleted_at).toBeUndefined();
        expect(db._tables.org_members).toHaveLength(5);
    });

    it.each(["admin", "owner"])(
        "stops an admin promoting a member to %s",
        async (role) => {
            const db = seedTiers();
            await expect(
                updateMember(db, {
                    actorId: "orgadmin1",
                    orgId: "o1",
                    targetUserId: "member1",
                    role,
                }),
            ).resolves.toMatchObject({ ok: false, kind: "owner_required" });
            expect(roleOf(db, "member1")).toBe("member");
        },
    );

    it("stops an admin promoting themselves", async () => {
        const db = seedTiers();
        await expect(
            updateMember(db, {
                actorId: "orgadmin1",
                orgId: "o1",
                targetUserId: "orgadmin1",
                role: "owner",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "owner_required" });
        expect(roleOf(db, "orgadmin1")).toBe("admin");
    });

    it.each([
        ["an owner", "owner1", "owner"],
        ["a peer admin", "orgadmin2", "admin"],
    ])("stops an admin demoting or removing %s", async (_label, target, role) => {
        // Checked on the role the target holds NOW. Validating only the
        // requested role would wave this through, because "member" is a role
        // an admin may otherwise hand out.
        const db = seedTiers();
        await expect(
            updateMember(db, {
                actorId: "orgadmin1",
                orgId: "o1",
                targetUserId: target,
                role: "member",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "owner_required" });
        await expect(
            removeMember(db, {
                actorId: "orgadmin1",
                orgId: "o1",
                targetUserId: target,
            }),
        ).resolves.toMatchObject({ ok: false, kind: "owner_required" });
        expect(roleOf(db, target)).toBe(role);
    });

    it("lets an admin remove a member and leave on their own", async () => {
        const db = seedTiers();
        await expect(
            removeMember(db, {
                actorId: "orgadmin1",
                orgId: "o1",
                targetUserId: "member1",
            }),
        ).resolves.toMatchObject({ ok: true });
        await expect(
            removeMember(db, {
                actorId: "orgadmin1",
                orgId: "o1",
                targetUserId: "orgadmin1",
            }),
        ).resolves.toMatchObject({ ok: true });
        expect(roleOf(db, "member1")).toBeUndefined();
        expect(roleOf(db, "orgadmin1")).toBeUndefined();
    });

    it("lets an owner act on admins and on other owners", async () => {
        const db = seedTiers();
        await expect(
            updateMember(db, {
                actorId: "owner1",
                orgId: "o1",
                targetUserId: "owner2",
                role: "admin",
            }),
        ).resolves.toMatchObject({ ok: true });
        await expect(
            removeMember(db, {
                actorId: "owner1",
                orgId: "o1",
                targetUserId: "orgadmin2",
            }),
        ).resolves.toMatchObject({ ok: true });
        expect(roleOf(db, "owner2")).toBe("admin");
        expect(roleOf(db, "orgadmin2")).toBeUndefined();
    });

    it("lets an admin invite members but not admins", async () => {
        const db = seedTiers();
        await expect(
            createInvitation(db, {
                actorId: "orgadmin1",
                orgId: "o1",
                email: "newbie@acme.example",
                role: "admin",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "owner_required" });
        expect(db._tables.org_invitations).toHaveLength(0);

        await expect(
            createInvitation(db, {
                actorId: "orgadmin1",
                orgId: "o1",
                email: "newbie@acme.example",
                role: "member",
            }),
        ).resolves.toMatchObject({ ok: true });
    });

    it("never offers ownership by invitation, whoever asks", async () => {
        const db = seedTiers();
        await expect(
            createInvitation(db, {
                actorId: "owner1",
                orgId: "o1",
                email: "newbie@acme.example",
                role: "owner",
            }),
        ).resolves.toMatchObject({
            ok: false,
            kind: "validation",
            detail: "Role must be admin or member",
        });
        expect(db._tables.org_invitations).toHaveLength(0);
    });

    it("keeps an owner's admin invitation out of an admin's hands", async () => {
        const db = seedTiers();
        const created = await createInvitation(db, {
            actorId: "owner1",
            orgId: "o1",
            email: "newbie@acme.example",
            role: "admin",
        });
        if (!created.ok) throw new Error("setup failed");
        const invitationId = created.invitation.id as string;

        await expect(
            cancelInvitation(db, {
                actorId: "orgadmin1",
                orgId: "o1",
                invitationId,
            }),
        ).resolves.toMatchObject({ ok: false, kind: "owner_required" });
        await expect(
            resendInvitation(db, {
                actorId: "orgadmin1",
                orgId: "o1",
                invitationId,
            }),
        ).resolves.toMatchObject({ ok: false, kind: "owner_required" });
        expect((db._tables.org_invitations as Row[])[0].status).toBe("pending");

        await expect(
            cancelInvitation(db, {
                actorId: "owner2",
                orgId: "o1",
                invitationId,
            }),
        ).resolves.toMatchObject({ ok: true });
    });

    it("leaves an admin an admin when they accept a member invitation", async () => {
        const db = seedTiers();
        (db._tables.org_invitations as Row[]).push({
            id: "inv-weak",
            org_id: "o1",
            email: "orgadmin@acme.example",
            role: "member",
            status: "pending",
            invited_by: "owner1",
            expires_at: new Date(Date.now() + 86_400_000).toISOString(),
            created_at: "t1",
        });
        await expect(
            acceptInvitation(db, {
                userId: "orgadmin1",
                userEmail: "orgadmin@acme.example",
                invitationId: "inv-weak",
            }),
        ).resolves.toMatchObject({ ok: true, role: "admin" });
        expect(roleOf(db, "orgadmin1")).toBe("admin");
    });
});
