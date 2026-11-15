import { describe, expect, it } from "vitest";
import { tableDb } from "../../__tests__/helpers/tableDb";
import { listProjectPeople, upsertProjectGrant } from "../projectAccess";
import { upsertContentGrant } from "../contentAccess";
import { listContentPeople } from "../resourcePeople";
type Row = Record<string, unknown>;

// The sharer and a colleague share an organization; the stranger has an
// account but no organization in common with the sharer.
function world(extra: Record<string, Row[]> = {}) {
    return tableDb({
        user_profiles: [
            { user_id: "sharer", email: "sharer@firm.test", display_name: "Sharer" },
            { user_id: "colleague", email: "colleague@firm.test", display_name: "Colleague" },
            { user_id: "stranger", email: "stranger@else.test", display_name: "Stranger Name" },
        ],
        org_members: [
            { org_id: "firm", user_id: "sharer", role: "owner" },
            { org_id: "firm", user_id: "colleague", role: "member" },
            { org_id: "else", user_id: "stranger", role: "owner" },
        ],
        project_access_grants: [],
        chat_access_grants: [],
        share_invitations: [],
        audit_events: [],
        ...extra,
    });
}

const PROJECT = { id: "project-1", user_id: "sharer", org_id: null };
const shareProject = (db: ReturnType<typeof world>["db"], email: string, role = "editor") =>
    upsertProjectGrant(db, {
        projectId: PROJECT.id,
        email,
        role,
        createdBy: "sharer",
        createdByEmail: "sharer@firm.test",
        creatorEmail: "sharer@firm.test",
    });

/** A roster entry with its address replaced, to compare two people's. */
function anonymous(entry: Row | undefined) {
    return { ...entry, email: "<address>" };
}

describe("sharing with someone outside the sharer's organizations", () => {
    it("answers the same for an address with an account and one without", async () => {
        const { db, tables } = world();

        const withAccount = await shareProject(db, "Stranger@Else.test");
        const withoutAccount = await shareProject(db, "nobody@else.test");

        expect(withAccount).toEqual({
            ok: true,
            grant: { email: "stranger@else.test", role: "editor", pending: true },
        });
        expect({ ...withoutAccount, grant: { ...(withoutAccount as { grant: Row }).grant, email: "stranger@else.test" } })
            .toEqual(withAccount);
        // Neither is a grant yet, so neither has access.
        expect(tables.project_access_grants).toEqual([]);

        const people = await listProjectPeople(db, PROJECT);
        if (!people.ok) throw new Error(people.detail);
        const stranger = people.members.find((m) => m.email === "stranger@else.test");
        const nobody = people.members.find((m) => m.email === "nobody@else.test");
        expect(stranger).toEqual({
            user_id: null,
            email: "stranger@else.test",
            display_name: null,
            profile_photo: null,
            role: "editor",
            pending: true,
        });
        expect(anonymous(nobody)).toEqual(anonymous(stranger));
    });

    it("does the same for a personal chat", async () => {
        const { db } = world();
        const share = (email: string) =>
            upsertContentGrant(db, {
                kind: "chat",
                resourceId: "chat-1",
                email,
                role: "viewer",
                createdBy: "sharer",
                orgId: null,
            });
        const withAccount = await share("stranger@else.test");
        const withoutAccount = await share("nobody@else.test");
        expect(withAccount).toEqual({
            ok: true,
            grant: { email: "stranger@else.test", role: "viewer", pending: true },
        });
        expect((withoutAccount as { grant: Row }).grant).toEqual({
            email: "nobody@else.test",
            role: "viewer",
            pending: true,
        });

        const people = await listContentPeople(db, "chat", {
            id: "chat-1",
            user_id: "sharer",
            project_id: null,
        });
        if (!people.ok) throw new Error(people.detail);
        const [first, second] = people.members;
        expect(first).toMatchObject({ display_name: null, user_id: null, pending: true });
        expect(anonymous(second)).toEqual(anonymous(first));
    });

});

describe("sharing with a colleague (counterexample)", () => {
    it("grants a member of a shared organization at once, as before", async () => {
        const { db, tables } = world();
        const result = await shareProject(db, "colleague@firm.test");
        expect(result).toMatchObject({ ok: true, grant: { email: "colleague@firm.test", role: "editor" } });
        expect((result as { grant: Row }).grant.pending).toBeUndefined();
        expect(tables.project_access_grants).toHaveLength(1);
        expect(tables.share_invitations).toEqual([]);

        const people = await listProjectPeople(db, PROJECT);
        if (!people.ok) throw new Error(people.detail);
        expect(people.members).toEqual([
            expect.objectContaining({ email: "colleague@firm.test", display_name: "Colleague", user_id: "colleague" }),
        ]);
    });

    it("changes the role of someone who already holds a grant at once", async () => {
        const { db, tables } = world({
            project_access_grants: [
                { id: "g1", project_id: PROJECT.id, email: "stranger@else.test", role: "viewer" },
            ],
        });
        await shareProject(db, "stranger@else.test", "owner");
        expect(tables.project_access_grants).toEqual([
            expect.objectContaining({ email: "stranger@else.test", role: "owner" }),
        ]);
        expect(tables.share_invitations).toEqual([]);
    });
});

describe("an organization's chat", () => {
    it("refuses an outsider the same way whether or not they have an account", async () => {
        const { db } = world();
        const share = (email: string) =>
            upsertContentGrant(db, {
                kind: "chat",
                resourceId: "chat-1",
                email,
                role: "viewer",
                createdBy: "sharer",
                orgId: "firm",
            });
        expect(await share("stranger@else.test")).toEqual({
            ok: false,
            kind: "validation",
            detail: "stranger@else.test is not a member of this organization.",
        });
        expect(await share("nobody@else.test")).toEqual({
            ok: false,
            kind: "validation",
            detail: "nobody@else.test is not a member of this organization.",
        });
    });
});

