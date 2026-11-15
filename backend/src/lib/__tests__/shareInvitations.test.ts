import { describe, expect, it, vi } from "vitest";
import { tableDb } from "../../__tests__/helpers/tableDb";
import { upsertProjectGrant, deleteProjectGrant } from "../projectAccess";
import {
    claimPendingShares,
    expirePendingShares,
    listPendingShares,
} from "../shareInvitations";

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


describe("withdrawing a pending share", () => {
    it("audits the share and lets the owner withdraw it before it is claimed", async () => {
        const { db, tables } = world();
        await shareProject(db, "nobody@else.test");
        expect(tables.audit_events.map((e) => e.action)).toEqual(["share.invite.created"]);

        const removed = await deleteProjectGrant(db, {
            projectId: PROJECT.id,
            email: "nobody@else.test",
            actorId: "sharer",
        });
        expect(removed).toEqual({ ok: true, removed: true });
        expect(tables.share_invitations[0]).toMatchObject({ status: "cancelled" });
        expect(tables.audit_events.map((e) => e.action)).toEqual([
            "share.invite.created",
            "share.invite.cancelled",
        ]);
        const pending = await listPendingShares(db, "project", PROJECT.id);
        expect(pending).toEqual({ ok: true, shares: [] });
    });
});

describe("claiming and expiry", () => {
    it("claims only with a confirmed address, and audits what it resolved", async () => {
        const { db, tables } = world();
        const rpc = vi.fn(async () => ({
            data: [
                {
                    invitation_id: "i1",
                    resource_kind: "project",
                    resource_id: PROJECT.id,
                    email: "nobody@else.test",
                    role: "editor",
                    invited_by: "sharer",
                    outcome: "accepted",
                },
                {
                    invitation_id: "i2",
                    resource_kind: "workflow",
                    resource_id: "wf-1",
                    email: "nobody@else.test",
                    role: "owner",
                    invited_by: "former-owner",
                    outcome: "refused",
                },
            ],
            error: null,
        }));
        const withRpc = Object.assign(db, { rpc }) as typeof db;

        // An unconfirmed address reaches requireAuth as "".
        await claimPendingShares(withRpc, { userId: "new", userEmail: "" });
        expect(rpc).not.toHaveBeenCalled();

        await claimPendingShares(withRpc, { userId: "new", userEmail: "nobody@else.test" });
        expect(rpc).toHaveBeenCalledWith("claim_share_invitations", { p_user_id: "new" });
        expect(tables.audit_events.map((e) => [e.action, e.project_id ?? null])).toEqual([
            ["share.invite.accepted", PROJECT.id],
            ["share.invite.refused", null],
        ]);
    });

    it("expires lapsed pending shares and audits each against its sharer", async () => {
        const { db, tables } = world({
            share_invitations: [
                { id: "old", project_id: PROJECT.id, email: "a@else.test", role: "viewer", invited_by: "sharer",
                  status: "pending", expires_at: "2020-01-01T00:00:00.000Z", created_at: "2019-12-18T00:00:00.000Z" },
                { id: "live", project_id: PROJECT.id, email: "b@else.test", role: "viewer", invited_by: "sharer",
                  status: "pending", expires_at: "2999-01-01T00:00:00.000Z", created_at: "2026-11-15T00:00:00.000Z" },
            ],
        });
        // A lapsed share is no longer listed, even before the sweep runs.
        expect((await listPendingShares(db, "project", PROJECT.id) as { shares: Row[] }).shares.map((s) => s.id))
            .toEqual(["live"]);

        expect(await expirePendingShares(db)).toBe(1);
        expect(tables.share_invitations.map((s) => s.status)).toEqual(["expired", "pending"]);
        expect(tables.audit_events).toEqual([
            expect.objectContaining({ action: "share.invite.expired", user_id: "sharer", project_id: PROJECT.id }),
        ]);
    });
});
